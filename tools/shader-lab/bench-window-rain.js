/**
 * WINDOW RAIN BENCH — rain on window light, on a real WebGPU device, with no
 * Foundry anywhere near it.
 *
 * ============================================================================
 * WHY THIS BENCH EXISTS AT ALL
 * ============================================================================
 * `window-rain.js` has a plain-JS twin asserted in Node (every formula, the
 * regimes, the slide direction) and `window-render.test.mjs` proves the TSL
 * graph CONSTRUCTS. Neither can say whether the shader, once compiled to WGSL
 * and run, computes what the twin computes, or whether the flow field's two
 * byte textures are read the right way up. Those are exactly the failure modes
 * that stay invisible: a transcription slip that still renders pretty drops, and
 * a Y-flip (`feedback_y_flip_recurring_risk`) that makes every south window run
 * its water NORTH.
 *
 * So this bench is built around three questions the Node suite cannot answer:
 *   1. TWIN PARITY     - the GPU's offset and gain, pixel for pixel, against
 *                        `evalWindowRainPixel` (the twin the tests pin).
 *   2. DIRECTION       - measured, not trusted: the sliding drops are tracked
 *                        frame to frame by block matching, per wall, and must
 *                        travel toward the wall they sit on.
 *   3. NO TEARING      - at a building corner the two facets blend; a rotated
 *                        lattice would cut a seam along the bisector.
 * plus the contracts around them: a dry pane is pixel-identical to a material
 * with no rain at all, weather never rebuilds a pipeline, and the flow textures
 * rewrite in place.
 *
 * ⚠️ HOUSE RULES (AGENTS.md section 6): it IMPORTS the real `src/` material, the
 * real rain handle and the real flow derivation. Nothing is transcribed. The
 * orientation of the readback is CALIBRATED, never assumed, on a fixture that is
 * deliberately asymmetric in Y. And lab-green is `BUILT (unverified)`, always.
 *
 * @module tools/shader-lab/bench-window-rain
 */

import { check, evaluate, registerBench, saveCanvasPng } from './contract.js';
import { buildWindowSurfaceMaterial } from '../../src/effects/window/window-render.js';
import {
  createWindowRain,
  resolveRainFrame,
  evalWindowRainPixel,
  WINDOW_RAIN_DEFAULTS,
  RAIN_TUNE,
} from '../../src/effects/window/window-rain.js';
import {
  deriveWindowRainField,
  buildWindowPresenceGrid,
  sampleWindowRainField,
} from '../../src/effects/window/window-rain-field.js';
import { QUAD_UVS, QUAD_INDICES, buildQuadPositions } from '../../src/scene/index.js';
import { WINDOW_DEBUG_CHANNELS } from '../../src/effects/window/window.js';

/** Rows of a copied texture pad to 256 bytes: DIM * 4 must be a multiple of 256. 1024 * 4 = 16 * 256. */
const DIM = 1024;
/** ONE WORLD PIXEL = ONE SCREEN PIXEL, so every offset in px can be measured with a ruler. */
const WORLD = Object.freeze({ minX: 0, maxX: DIM, minY: 0, maxY: DIM });
const GRID = 128;
const CELL = DIM / GRID;
const MASK = 512;

/** The building (open air outside it). */
const BUILDING = Object.freeze({ x0: 160, y0: 160, x1: 864, y1: 864 });

/**
 * The window pools, in world px. ASYMMETRIC IN Y ON PURPOSE (AGENTS.md section 10: "a feature centred in Y cannot
 * calibrate a Y-flip"): the south pool is 320 wide and the north 192, so the same x is lit on one side only.
 * The corner pool sits at the south-east corner, clear of the south and east pools by 32 px (4 cells).
 */
const POOLS = Object.freeze({
  south: { x0: 352, y0: 736, x1: 672, y1: 832 },
  north: { x0: 416, y0: 192, x1: 608, y1: 288 },
  east: { x0: 736, y0: 352, x1: 832, y1: 672 },
  west: { x0: 192, y0: 384, x1: 288, y1: 608 },
  corner: { x0: 704, y0: 704, x1: 832, y1: 832 },
});

/** Where each wall's water must run: toward the wall the pool sits against (world +x east, +y south). */
const EXPECT_DIR = Object.freeze({ south: [0, 1], north: [0, -1], east: [1, 0], west: [-1, 0] });

const DEBUG_RAIN_FLOW = 13;
const DEBUG_RAIN_AUX = 14;
const DEBUG_RAIN_DROPS = 15;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** @param {object} pool @returns {{cx:number, cy:number}} */
const centreOf = (pool) => ({ cx: 0.5 * (pool.x0 + pool.x1), cy: 0.5 * (pool.y0 + pool.y1) });

/** The synthetic `_Outdoors` grid: open air, with the building painted black. */
function buildOutdoors() {
  const data = new Uint8Array(GRID * GRID).fill(255);
  for (let y = BUILDING.y0 / CELL; y < BUILDING.y1 / CELL; y++) {
    for (let x = BUILDING.x0 / CELL; x < BUILDING.x1 / CELL; x++) data[y * GRID + x] = 0;
  }
  return data;
}

/** The synthetic `_Window` file: every pool a soft-edged, slightly warm patch of light. RGBA, `MASK` squared. */
function buildMask() {
  const data = new Uint8Array(MASK * MASK * 4);
  const scale = DIM / MASK;
  for (let my = 0; my < MASK; my++) {
    for (let mx = 0; mx < MASK; mx++) {
      const wx = (mx + 0.5) * scale;
      const wy = (my + 0.5) * scale;
      let best = 0;
      for (const p of Object.values(POOLS)) {
        const edge = Math.min(wx - p.x0, p.x1 - wx, wy - p.y0, p.y1 - wy);
        best = Math.max(best, clamp01(edge / 14));
      }
      if (best <= 0) continue;
      const i = (my * MASK + mx) * 4;
      const level = 0.85 * best;
      data[i] = Math.round(255 * level);
      data[i + 1] = Math.round(255 * level * 0.96);
      data[i + 2] = Math.round(255 * level * 0.86);
      data[i + 3] = 255;
    }
  }
  return data;
}

/**
 * @param {object} args
 * @param {*} args.THREE
 * @param {(msg: string) => void} [args.log]
 */
export function createWindowRainBench({ THREE, log }) {
  const { uniform, vec4, max, float } = THREE.TSL;

  let renderer = null;
  let camera = null;
  let target = null;
  let scene = null;
  let mesh = null;
  let surface = null;
  let rain = null;
  let maskTexture = null;
  let neutralDirs = null;
  let neutralAux = null;
  let flowDirs = null;
  let flowAux = null;
  let field = null;
  /** Readback row order, established empirically. Never assumed. */
  let orientation = null;
  let builtFor = { glass: null, withRain: null };
  let lastFrame = null;

  const spec = { x: 0, y: 0, width: DIM, height: DIM, w: GRID, h: GRID, texelW: CELL, texelH: CELL };
  const outdoors = buildOutdoors();
  const maskPixels = buildMask();
  const uViewRect = uniform(vec4(WORLD.minX, WORLD.minY, WORLD.maxX, WORLD.maxY));

  /** The live state the page and every scenario drive. */
  const state = {
    glass: true,
    withRain: true,
    rain01: 0.6,
    wet01: 0.9,
    clock: 40,
    slideClock: 25,
    windSpeed01: 0,
    windDirDeg: 0,
    windShift: [0, 0],
    gust01: 0,
    look: { ...WINDOW_RAIN_DEFAULTS },
    easePx: 96,
    /** Fields stamped over the resolved frame, to isolate one regime (e.g. sliders only). */
    override: {},
    debugChannel: 0,
  };

  async function ensureRenderer() {
    if (renderer) return;
    renderer = new THREE.WebGPURenderer({ antialias: false });
    await renderer.init();
    camera = new THREE.OrthographicCamera(WORLD.minX, WORLD.maxX, WORLD.maxY, WORLD.minY, -1000, 1000);
    camera.position.set(0, 0, 100);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    target = new THREE.RenderTarget(DIM, DIM, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
    });
    log?.(`WINDOW-RAIN: renderer backend ${renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL'}`);
  }

  /** A raw-bytes RGBA DataTexture: no colour management, linear filtering, no flip (the way `vt/` makes masks). */
  function dataTexture(data, w, h) {
    const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = THREE.NoColorSpace;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  }

  function ensureFixture() {
    if (!maskTexture) {
      maskTexture = dataTexture(maskPixels, MASK, MASK);
      neutralDirs = dataTexture(new Uint8Array([128, 128, 128, 128]), 1, 1);
      neutralAux = dataTexture(new Uint8Array([0, 0, 128, 255]), 1, 1);
    }
    if (!field) deriveFlow(state.easePx);
  }

  /**
   * Derive the flow field from the fixture, exactly the way the subsystem does (presence pooled from the full
   * mask pixels, so the blue/any-channel cookie counts), and upload it - IN PLACE once the textures exist.
   * @param {number} easePx
   */
  function deriveFlow(easePx) {
    const presence = buildWindowPresenceGrid({
      data: maskPixels,
      width: MASK,
      height: MASK,
      rect: { minX: 0, minY: 0, maxX: DIM, maxY: DIM },
      spec,
    });
    field = deriveWindowRainField({ outdoors: { spec, data: outdoors }, presence, easePx, maxDim: 4096 });
    if (!field) throw new Error('window-rain bench: the fixture derived no flow field');
    if (!flowDirs) {
      flowDirs = dataTexture(field.dirs, GRID, GRID);
      flowAux = dataTexture(field.aux, GRID, GRID);
    } else {
      flowDirs.image.data.set(field.dirs);
      flowDirs.needsUpdate = true;
      flowAux.image.data.set(field.aux);
      flowAux.needsUpdate = true;
    }
    state.easePx = easePx;
    rain?.setFlow({ dirsTexture: flowDirs, auxTexture: flowAux, rect: { x: 0, y: 0, width: DIM, height: DIM } });
  }

  function buildScene() {
    ensureFixture();
    scene = new THREE.Scene();
    rain = state.withRain
      ? createWindowRain({
          THREE,
          flowDirsTexture: neutralDirs,
          flowAuxTexture: neutralAux,
          viewSpanNode: max(uViewRect.z.sub(uViewRect.x), float(1)),
        })
      : null;
    surface = buildWindowSurfaceMaterial({
      THREE,
      maskTexture,
      // NULL ON PURPOSE: the floor gate compiles out, the honest shape for a bench with no floors.
      depthTexture: null,
      uViewRect,
      glass: state.glass,
      rain,
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
    geometry.setIndex(Array.from(QUAD_INDICES));
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(
        buildQuadPositions([
          { x: WORLD.minX, y: WORLD.minY },
          { x: WORLD.maxX, y: WORLD.minY },
          { x: WORLD.maxX, y: WORLD.maxY },
          { x: WORLD.minX, y: WORLD.maxY },
        ]),
        3
      )
    );
    mesh = new THREE.Mesh(geometry, surface.windowMaterial);
    mesh.frustumCulled = false;
    scene.add(mesh);
    surface.setMaskUvBounds({ minU: 0, minV: 0, maxU: 1, maxV: 1 });
    surface.setUvPerWorldPx(1 / (WORLD.maxX - WORLD.minX), 1 / (WORLD.maxY - WORLD.minY));
    rain?.setFlow({ dirsTexture: flowDirs, auxTexture: flowAux, rect: { x: 0, y: 0, width: DIM, height: DIM } });
    builtFor = { glass: state.glass, withRain: state.withRain };
  }

  /** Push the live state through the real setters, the same calls the subsystem makes every sync. */
  function pushState() {
    surface.setGlass({});
    surface.setDebugChannel(state.debugChannel);
    mesh.material = state.debugChannel > 0 ? surface.debugMaterial : surface.windowMaterial;
    if (!rain) return;
    rain.setLook(state.look);
    const wind = {
      x: Math.sin((state.windDirDeg * Math.PI) / 180),
      y: -Math.cos((state.windDirDeg * Math.PI) / 180),
    };
    const frame = {
      ...resolveRainFrame({
        rain01: state.rain01,
        wet01: state.wet01,
        look: state.look,
        windSpeed01: state.windSpeed01,
        gust01: state.gust01,
      }),
      ...state.override,
    };
    frame.windFlowX = wind.x;
    frame.windFlowY = wind.y;
    lastFrame = frame;
    rain.setFrame(frame, {
      clock: state.clock,
      slideClock: state.slideClock,
      windFlow: [wind.x, wind.y],
      windShift: state.windShift,
    });
  }

  async function renderFrame() {
    await ensureRenderer();
    if (!scene || builtFor.glass !== state.glass || builtFor.withRain !== state.withRain) buildScene();
    pushState();
    const prev = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClearColor;
    renderer.setRenderTarget(target);
    // BLACK, because this pass ADDS: whatever comes back IS the cookie's own contribution to the illum buffer.
    renderer.setClearColor(new THREE.Color(0, 0, 0), 1);
    renderer.autoClearColor = true;
    renderer.clear();
    await renderer.renderAsync(scene, camera);
    renderer.setRenderTarget(prev);
    renderer.autoClearColor = prevAutoClear;
    return renderer.readRenderTargetPixelsAsync(target, 0, 0, DIM, DIM);
  }

  /** Apply overrides, render, restore. Keeps scenarios from leaking state. */
  async function renderWith(overrides) {
    const saved = { ...state, look: { ...state.look }, override: { ...state.override } };
    Object.assign(state, overrides);
    try {
      return await renderFrame();
    } finally {
      Object.assign(state, saved);
    }
  }

  // ── readback geometry ────────────────────────────────────────────────────
  /** Byte index of world pixel (x, y), honouring the empirically found row order. */
  function idx(x, y) {
    const px = Math.min(DIM - 1, Math.max(0, Math.floor(x)));
    const wy = Math.min(DIM - 1, Math.max(0, Math.floor(y)));
    return ((orientation === 'flipped' ? DIM - 1 - wy : wy) * DIM + px) * 4;
  }
  const sampleAt = (bytes, x, y) => {
    const i = idx(x, y);
    return { r: bytes[i], g: bytes[i + 1], b: bytes[i + 2], a: bytes[i + 3] };
  };

  /**
   * ESTABLISH ROW ORDER EMPIRICALLY. The probe is the Y asymmetry of the fixture: x = 380 is inside the 320-wide
   * south pool at y = 784 and outside the 192-wide north pool at y = 240. Those predictions swap under a flip.
   * Throws when the mask did not render at all, because then nothing below would mean anything.
   * @param {Uint8Array} bytes - a DRY frame.
   */
  function calibrate(bytes) {
    const at = (x, y) => {
      const i = (Math.floor(y) * DIM + Math.floor(x)) * 4;
      return bytes[i] + bytes[i + 1] + bytes[i + 2];
    };
    const south = at(380, 784);
    const north = at(380, 240);
    if (Math.abs(south - north) < 60) {
      throw new Error(
        `window-rain calibrate: the south/north probe found no asymmetry (south=${south}, north=${north}); the mask did not render`
      );
    }
    orientation = south > north ? 'straight' : 'flipped';
    log?.(`WINDOW-RAIN: orientation ${orientation} (south probe=${south}, north probe=${north})`);
    return orientation;
  }

  function litStats(bytes) {
    let n = 0;
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < bytes.length; i += 4) {
      const lum = (bytes[i] + bytes[i + 1] + bytes[i + 2]) / 3;
      if (lum < 8) continue;
      n++;
      sum += lum;
      if (lum > peak) peak = lum;
    }
    return { litPixels: n, mean: +(n ? sum / n : 0).toFixed(3), peak };
  }

  /** The fraction of pixels lit in EITHER frame whose luminance differs by more than `threshold`/255. */
  function changedFraction(a, b, threshold = 6) {
    let lit = 0;
    let changed = 0;
    for (let i = 0; i < a.length; i += 4) {
      const la = (a[i] + a[i + 1] + a[i + 2]) / 3;
      const lb = (b[i] + b[i + 1] + b[i + 2]) / 3;
      if (la < 8 && lb < 8) continue;
      lit++;
      if (Math.abs(la - lb) > threshold) changed++;
    }
    return lit ? changed / lit : 0;
  }

  function bytesEqual(a, b) {
    let differing = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing++;
    return differing;
  }

  /** One channel of a world rectangle as floats, rows in ascending WORLD y whatever the readback order is. */
  function grab(bytes, channel, x0, y0, x1, y1) {
    const w = x1 - x0;
    const h = y1 - y0;
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) out[y * w + x] = bytes[idx(x0 + x, y0 + y) + channel];
    }
    return { data: out, w, h };
  }

  /** The centres of the small blobs of lens offset in a region (the heads of the running drops), world-oriented. */
  function blobsOf(bytes, x0, y0, x1, y1) {
    const w = x1 - x0;
    const h = y1 - y0;
    const mag = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = idx(x0 + x, y0 + y);
        mag[y * w + x] = Math.abs(bytes[i + 1] - 128) + Math.abs(bytes[i + 2] - 128);
      }
    }
    const seen = new Uint8Array(w * h);
    const blobs = [];
    for (let s0 = 0; s0 < w * h; s0++) {
      if (seen[s0] || !(mag[s0] > 10)) continue;
      const stack = [s0];
      seen[s0] = 1;
      let sx = 0;
      let sy = 0;
      let n = 0;
      while (stack.length) {
        const k = stack.pop();
        const px = k % w;
        const py = (k - px) / w;
        sx += px;
        sy += py;
        n++;
        for (const [qx, qy] of [
          [px + 1, py],
          [px - 1, py],
          [px, py + 1],
          [px, py - 1],
        ]) {
          if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
          const j = qy * w + qx;
          if (!seen[j] && mag[j] > 10) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
      if (n >= 4) blobs.push({ x: x0 + sx / n, y: y0 + sy / n });
    }
    return blobs;
  }

  /** A canvas of world-oriented pixels, `scale` times larger, for artifacts. */
  function cropCanvas(bytes, x0, y0, x1, y1, scale = 1, label = '') {
    const w = x1 - x0;
    const h = y1 - y0;
    const canvas = document.createElement('canvas');
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = idx(x0 + x, y0 + y);
        const o = (y * w + x) * 4;
        img.data[o] = bytes[i];
        img.data[o + 1] = bytes[i + 1];
        img.data[o + 2] = bytes[i + 2];
        img.data[o + 3] = 255;
      }
    }
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    tmp.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, w * scale, h * scale);
    if (label) {
      ctx.fillStyle = '#0f0';
      ctx.font = '14px monospace';
      ctx.fillText(label, 6, 18);
    }
    return canvas;
  }

  /** Stack canvases into a grid. */
  function montage(canvases, cols) {
    const cw = canvases[0].width;
    const ch = canvases[0].height;
    const rows = Math.ceil(canvases.length / cols);
    const out = document.createElement('canvas');
    out.width = cols * cw + (cols - 1) * 4;
    out.height = rows * ch + (rows - 1) * 4;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#222';
    ctx.fillRect(0, 0, out.width, out.height);
    canvases.forEach((c, k) => ctx.drawImage(c, (k % cols) * (cw + 4), Math.floor(k / cols) * (ch + 4)));
    return out;
  }

  function paint(bytes, label) {
    const canvas = document.getElementById('windowRainView');
    if (!canvas) return;
    const c = cropCanvas(bytes, 0, 0, DIM, DIM, 1, label);
    canvas.width = DIM;
    canvas.height = DIM;
    canvas.getContext('2d').drawImage(c, 0, 0);
  }

  const pipelineCount = () => {
    const caches = renderer?._pipelines?.caches;
    return caches instanceof Map ? caches.size : null;
  };

  /** Render dry once and calibrate; returns the dry frame, or throws. */
  async function calibrated(glass) {
    const dry = await renderWith({ glass, rain01: 0, wet01: 0 });
    calibrate(dry);
    return dry;
  }

  /** Sliders ONLY: no splats, no sheet, no impacts, no dim, no wind. Isolates the running drops. */
  const SLIDERS_ONLY = Object.freeze({ cover: 0, sheet: 0, impact: 0, slider: 1, presence: 1, dim: 1, windBias: 0 });

  const scenarios = new Map();

  // ═══════════════════════════════════════════════════════════════════════
  scenarios.set('dry-is-identity', {
    name: 'dry-is-identity',
    summary:
      'A dry pane must be pixel-for-pixel what the material drew before rain existed. Renders the same cookie ' +
      'with NO rain handle and with a rain handle at zero rain, at the glass tier and the bare cookie tier.',
    async run(ctx) {
      const checks = [];
      let calibration = 'OK';
      const artifacts = [];
      const stats = {};
      try {
        await calibrated(true);
      } catch (err) {
        calibration = 'FAILED';
        checks.push(check({ id: 'orientation-calibrated', status: 'UNMEASURED', measured: String(err.message) }));
      }
      for (const glass of [true, false]) {
        const tier = glass ? 'glass' : 'cookie';
        const none = await renderWith({ glass, withRain: false, rain01: 0, wet01: 0 });
        const dryRain = await renderWith({ glass, withRain: true, rain01: 0, wet01: 0 });
        const lit = litStats(none);
        const differing = bytesEqual(none, dryRain);
        stats[tier] = { lit, differingBytes: differing };
        checks.push(
          evaluate(`the-cookie-renders-at-the-${tier}-tier`, () => ({
            ok: lit.litPixels > 30000,
            measured: lit,
            expected: 'five pools light well over 30k pixels',
          }))
        );
        checks.push(
          evaluate(`dry-rain-handle-is-pixel-identical-to-no-rain-at-the-${tier}-tier`, () => ({
            ok: differing === 0,
            measured: { differingBytes: differing },
            expected: 'zero differing bytes: the dry frame must not change by a single bit',
          }))
        );
        if (glass) {
          const wet = await renderWith({ glass, withRain: true, rain01: 0.6, wet01: 0.96 });
          const frac = changedFraction(none, wet);
          stats.wetChangedFraction = +frac.toFixed(4);
          checks.push(
            evaluate('rain-actually-changes-the-picture', () => ({
              ok: frac > 0.01,
              measured: { changedFraction: frac },
              expected: 'wet differs from dry (a guard against a vacuous identity pass)',
            }))
          );
          artifacts.push(
            await saveCanvasPng(
              ctx.runId,
              'dry-vs-wet.png',
              montage(
                [
                  cropCanvas(none, 320, 160, 704, 340, 2, 'dry / no rain handle'),
                  cropCanvas(wet, 320, 160, 704, 340, 2, 'rain 0.6'),
                ],
                1
              )
            )
          );
        }
      }
      return { checks, calibration, artifacts: artifacts.filter(Boolean), inputs: { dim: DIM }, stats };
    },
  });

  // ═══════════════════════════════════════════════════════════════════════
  scenarios.set('flow-texture-orientation', {
    name: 'flow-texture-orientation',
    summary:
      'Reads the flow field back through the rainFlow debug channel and checks each pool reports the direction ' +
      'of its own wall. A Y-flip in how the flow texture is sampled would send every south window north.',
    async run(ctx) {
      const checks = [];
      let calibration = 'OK';
      try {
        await calibrated(true);
      } catch (err) {
        calibration = 'FAILED';
        checks.push(check({ id: 'orientation-calibrated', status: 'UNMEASURED', measured: String(err.message) }));
      }
      const flow = await renderWith({ debugChannel: DEBUG_RAIN_FLOW });
      const aux = await renderWith({ debugChannel: DEBUG_RAIN_AUX });
      const at = (name) => {
        const { cx, cy } = centreOf(POOLS[name]);
        return sampleAt(flow, cx, cy);
      };
      const s = at('south');
      const n = at('north');
      const e = at('east');
      const w = at('west');
      const c = at('corner');
      checks.push(
        evaluate('south-window-runs-south', () => ({
          ok: s.g > 230 && s.r > 105 && s.r < 150,
          measured: s,
          expected: 'G = 0.5 + 0.5 y near 1 (south), R near 0.5',
        }))
      );
      checks.push(
        evaluate('north-window-runs-north', () => ({
          ok: n.g < 25 && n.r > 105 && n.r < 150,
          measured: n,
          expected: 'G near 0 (north), R near 0.5',
        }))
      );
      checks.push(
        evaluate('east-window-runs-east', () => ({
          ok: e.r > 230 && e.g > 105 && e.g < 150,
          measured: e,
          expected: 'R near 1 (east), G near 0.5',
        }))
      );
      checks.push(
        evaluate('west-window-runs-west', () => ({
          ok: w.r < 25 && w.g > 105 && w.g < 150,
          measured: w,
          expected: 'R near 0 (west), G near 0.5',
        }))
      );
      checks.push(
        evaluate('corner-window-runs-between-east-and-south', () => ({
          ok: c.r > 150 && c.g > 150,
          measured: c,
          expected: 'a blend of east and south: both R and G well above mid',
        }))
      );
      checks.push(
        evaluate('open-air-and-the-building-interior-have-no-direction', () => {
          const a = sampleAt(flow, 40, 40);
          const b = sampleAt(flow, 512, 512);
          return {
            ok: a.r + a.g + a.b < 24 && b.r + b.g + b.b < 24,
            measured: { openAir: a, interior: b },
            expected: 'black where there is no window pool',
          };
        })
      );
      // The pane height: sill 0 at the wall, top 1 at the far end of the pool (blue channel of the flow view).
      checks.push(
        evaluate('the-sill-is-at-the-wall-and-the-top-at-the-far-end-of-the-south-pool', () => {
          const sill = sampleAt(flow, 512, 828).b;
          const top = sampleAt(flow, 512, 742).b;
          return {
            // the pane height is ABSOLUTE now (distance from the wall over 320 px), not normalised to the pool
            ok: sill < 60 && top > sill + 40,
            measured: { sill, top },
            expected: 'pane height ~0 against the wall (south edge), rising toward the far end (north edge)',
          };
        })
      );
      checks.push(
        evaluate('the-corner-pool-blend-ramps-across-its-diagonal', () => {
          // aux R = the cross-fade share of the second level (0 .. 1/2): sample along the anti-diagonal of the corner pool.
          const a = sampleAt(aux, 716, 820).r; // near the south wall side
          const m = sampleAt(aux, 768, 768).r;
          const b = sampleAt(aux, 820, 716).r; // near the east wall side
          return {
            ok: a < 20 && b < 20 && m > 30 && m <= 130,
            measured: { southSide: a, middle: m, eastSide: b },
            expected: 'a single level (mix ~0) beside each wall, a cross-fade (up to 1/2) at the diagonal between them',
          };
        })
      );
      const artifact = await saveCanvasPng(
        ctx.runId,
        'flow-views.png',
        montage(
          [
            cropCanvas(flow, 128, 128, 896, 896, 1, 'rainFlow (channel 13)'),
            cropCanvas(aux, 128, 128, 896, 896, 1, 'rainFlowAux (channel 14)'),
          ],
          2
        )
      );
      return {
        checks,
        calibration,
        artifacts: artifact ? [artifact] : [],
        inputs: { pools: POOLS },
        stats: { s, n, e, w, c },
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════════
  scenarios.set('twin-parity', {
    name: 'twin-parity',
    summary:
      "The GPU against the JS twin, pixel for pixel: the rainDrops channel encodes the shader's gain and lens " +
      'offset; this decodes it and compares with evalWindowRainPixel for the same weather, clocks, wind and flow ' +
      'field. Three weathers: drizzle, rain with a crosswind, a gusty storm.',
    async run(ctx) {
      const checks = [];
      let calibration = 'OK';
      try {
        await calibrated(true);
      } catch (err) {
        calibration = 'FAILED';
        checks.push(check({ id: 'orientation-calibrated', status: 'UNMEASURED', measured: String(err.message) }));
      }
      const REGION = { x0: 640, y0: 640, x1: 896, y1: 896 }; // the corner pool, the south pool's east end, the walls
      const configs = [
        {
          name: 'drizzle',
          rain01: 0.15,
          wet01: 0.3,
          windSpeed01: 0,
          windDirDeg: 0,
          gust01: 0,
          clock: 12.4,
          slideClock: 7.1,
        },
        {
          name: 'rain-crosswind',
          rain01: 0.55,
          wet01: 0.9,
          windSpeed01: 0.7,
          windDirDeg: 90,
          gust01: 0.1,
          clock: 37.3,
          slideClock: 21.7,
          windShift: [41.7, -23.9],
        },
        {
          name: 'gusty-storm',
          rain01: 1,
          wet01: 1,
          windSpeed01: 0.9,
          windDirDeg: 200,
          gust01: 0.8,
          clock: 101.9,
          slideClock: 66.2,
          windShift: [-310.2, 88.4],
        },
      ];
      const artifacts = [];
      const stats = {};
      for (const cfg of configs) {
        const bytes = await renderWith({ ...cfg, debugChannel: DEBUG_RAIN_DROPS });
        const frame = lastFrame;
        const look = { ...state.look };
        let n = 0;
        let bad = 0;
        let worstGain = 0;
        let worstOff = 0;
        let sumGpu = 0;
        let sumTwin = 0;
        const diff = document.createElement('canvas');
        diff.width = REGION.x1 - REGION.x0;
        diff.height = REGION.y1 - REGION.y0;
        const dctx = diff.getContext('2d');
        const dimg = dctx.createImageData(diff.width, diff.height);
        for (let y = REGION.y0; y < REGION.y1; y++) {
          for (let x = REGION.x0; x < REGION.x1; x++) {
            const i = idx(x, y);
            const gGpu = (bytes[i] / 255) * 2;
            const oxGpu = (bytes[i + 1] / 255 - 0.5) * 2 * RAIN_TUNE.maxOffsetPx;
            const oyGpu = (bytes[i + 2] / 255 - 0.5) * 2 * RAIN_TUNE.maxOffsetPx;
            const flow = sampleWindowRainField(field, x + 0.5, y + 0.5);
            const twin = evalWindowRainPixel({
              x: x + 0.5,
              y: y + 0.5,
              frame,
              look,
              clock: cfg.clock,
              slideClock: cfg.slideClock,
              flow,
              viewSpanPx: DIM,
              windShiftX: cfg.windShift?.[0] ?? 0,
              windShiftY: cfg.windShift?.[1] ?? 0,
            });
            const dg = Math.abs(gGpu - twin.gain);
            const dox = Math.abs(oxGpu - twin.offsetX);
            const doy = Math.abs(oyGpu - twin.offsetY);
            const off = Math.max(dox, doy);
            worstGain = Math.max(worstGain, dg);
            worstOff = Math.max(worstOff, off);
            n++;
            if (dg > 0.02 || off > 0.5) bad++;
            sumGpu += gGpu;
            sumTwin += twin.gain;
            const o = ((y - REGION.y0) * diff.width + (x - REGION.x0)) * 4;
            const e = Math.min(255, Math.round(255 * Math.max(dg / 0.1, off / 2)));
            dimg.data[o] = e;
            dimg.data[o + 1] = Math.round(gGpu * 100);
            dimg.data[o + 2] = Math.round(twin.gain * 100);
            dimg.data[o + 3] = 255;
          }
        }
        dctx.putImageData(dimg, 0, 0);
        const frac = bad / n;
        stats[cfg.name] = {
          pixels: n,
          mismatchFraction: +frac.toFixed(5),
          worstGain: +worstGain.toFixed(4),
          worstOffsetPx: +worstOff.toFixed(3),
          meanGpu: +(sumGpu / n).toFixed(5),
          meanTwin: +(sumTwin / n).toFixed(5),
        };
        checks.push(
          evaluate(`gpu-matches-the-twin-${cfg.name}`, () => ({
            ok: frac < 0.01,
            measured: stats[cfg.name],
            expected:
              'under 1% of pixels beyond 0.02 gain or 0.5 px offset (float32 vs float64 can flip a hash threshold in a few pixels)',
          }))
        );
        checks.push(
          evaluate(`gpu-and-twin-agree-on-the-mean-gain-${cfg.name}`, () => ({
            ok: Math.abs(sumGpu / n - sumTwin / n) < 0.004,
            measured: { gpu: sumGpu / n, twin: sumTwin / n },
            expected: 'region-mean gain within 0.004: the dimming agrees, not just the shapes',
          }))
        );
        artifacts.push(await saveCanvasPng(ctx.runId, `parity-${cfg.name}.png`, diff));
      }
      checks.push(
        evaluate('the-region-is-not-vacuous', () => {
          const s = stats['gusty-storm'];
          return {
            ok: Math.abs(s.meanTwin - 1) > 0.01,
            measured: { meanTwinGain: s.meanTwin },
            expected: 'a storm moves the mean gain, so agreement is not agreement about nothing',
          };
        })
      );
      return { checks, calibration, artifacts: artifacts.filter(Boolean), inputs: { region: REGION, configs }, stats };
    },
  });

  // ═══════════════════════════════════════════════════════════════════════
  scenarios.set('slide-direction-per-side', {
    name: 'slide-direction-per-side',
    summary:
      'The running drops, tracked frame to frame by block matching, per wall. Sliders only (no splats, no sheet). ' +
      'South must run +y, north -y, east +x, west -x: toward the wall each window sits in.',
    async run(ctx) {
      const checks = [];
      let calibration = 'OK';
      try {
        await calibrated(true);
      } catch (err) {
        calibration = 'FAILED';
        checks.push(check({ id: 'orientation-calibrated', status: 'UNMEASURED', measured: String(err.message) }));
      }
      const DT = 0.3;
      const MAXS = 14;
      const stats = {};
      const artifacts = [];
      for (const side of ['south', 'north', 'east', 'west']) {
        const p = POOLS[side];
        const x0 = p.x0 - MAXS;
        const y0 = p.y0 - MAXS;
        const x1 = p.x1 + MAXS;
        const y1 = p.y1 + MAXS;
        let sumX = 0;
        let sumY = 0;
        let moving = 0;
        let movedTotal = 0;
        let pairs = 0;
        let lastA = null;
        let lastB = null;
        for (let k = 0; k < 40; k++) {
          const sc = 3 + k * 0.7;
          const a = await renderWith({
            rain01: 0.8,
            wet01: 1,
            override: SLIDERS_ONLY,
            slideClock: sc,
            debugChannel: DEBUG_RAIN_DROPS,
          });
          const b = await renderWith({
            rain01: 0.8,
            wet01: 1,
            override: SLIDERS_ONLY,
            slideClock: sc + DT,
            debugChannel: DEBUG_RAIN_DROPS,
          });
          const A = blobsOf(a, x0, y0, x1, y1);
          const B = blobsOf(b, x0, y0, x1, y1);
          // Heads are small and most of them stand still (stick-slip), so a global block match is dragged to zero by
          // the ones that do not move. Track each head instead: the nearest head in the next frame within MAXS px.
          pairs++;
          let moved = 0;
          for (const p of A) {
            let q = null;
            let qd = MAXS * MAXS;
            for (const c of B) {
              const d2 = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
              if (d2 < qd) {
                qd = d2;
                q = c;
              }
            }
            if (q && qd >= 4) {
              sumX += q.x - p.x;
              sumY += q.y - p.y;
              moved++;
            }
          }
          if (moved > 0) moving++;
          movedTotal += moved;
          lastA = a;
          lastB = b;
        }
        const mx = movedTotal ? sumX / movedTotal : 0;
        const my = movedTotal ? sumY / movedTotal : 0;
        const len = Math.hypot(mx, my);
        const [ex, ey] = EXPECT_DIR[side];
        const cos = len > 0 ? (mx * ex + my * ey) / len : 0;
        stats[side] = {
          pairs,
          moving,
          meanShiftPx: [+mx.toFixed(2), +my.toFixed(2)],
          speedPxPerStep: +len.toFixed(2),
          cosToExpected: +cos.toFixed(3),
        };
        checks.push(
          evaluate(`${side}-drops-travel-toward-the-${side}-wall`, () => ({
            ok: moving >= 4 && len >= 0.8 && cos > 0.9,
            measured: stats[side],
            expected: `at least 4 moving frame pairs, mean shift >= 0.8 px, within ~25 degrees of (${ex}, ${ey})`,
          }))
        );
        if (side === 'south' || side === 'east') {
          artifacts.push(
            await saveCanvasPng(
              ctx.runId,
              `slide-${side}.png`,
              montage(
                [
                  cropCanvas(lastA, p.x0 - 20, p.y0 - 20, p.x1 + 20, p.y1 + 20, 2, `${side} t`),
                  cropCanvas(lastB, p.x0 - 20, p.y0 - 20, p.x1 + 20, p.y1 + 20, 2, `${side} t+${DT}s`),
                ],
                1
              )
            )
          );
        }
      }
      return {
        checks,
        calibration,
        artifacts: artifacts.filter(Boolean),
        inputs: { dtSec: DT, maxShiftPx: MAXS },
        stats,
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════════
  scenarios.set('corner-no-tear', {
    name: 'corner-no-tear',
    summary:
      'At the south-east corner two facets meet. Measures gradient energy of the sliding-drop pattern in a band ' +
      'along the corner bisector against the rest of the pool: a lattice rotated per pixel tears along it.',
    async run(ctx) {
      const checks = [];
      let calibration = 'OK';
      try {
        await calibrated(true);
      } catch (err) {
        calibration = 'FAILED';
        checks.push(check({ id: 'orientation-calibrated', status: 'UNMEASURED', measured: String(err.message) }));
      }
      const p = POOLS.corner;
      const inner = 10; // stay off the soft cookie edge
      let bandSum = 0;
      let bandN = 0;
      let farSum = 0;
      let farN = 0;
      let lastFrame2 = null;
      for (let k = 0; k < 14; k++) {
        const bytes = await renderWith({
          rain01: 0.9,
          wet01: 1,
          override: SLIDERS_ONLY,
          slideClock: 4 + k * 1.7,
          debugChannel: DEBUG_RAIN_DROPS,
        });
        lastFrame2 = bytes;
        const G = grab(bytes, 0, p.x0, p.y0, p.x1, p.y1);
        for (let y = inner; y < G.h - inner; y++) {
          for (let x = inner; x < G.w - inner; x++) {
            const gx = G.data[y * G.w + x + 1] - G.data[y * G.w + x - 1];
            const gy = G.data[(y + 1) * G.w + x] - G.data[(y - 1) * G.w + x];
            const g = Math.hypot(gx, gy);
            // The bisector of the south-east corner of the building is x = y (through the corner at 864, 864).
            const d = Math.abs(p.x0 + x - (p.y0 + y)) / Math.SQRT2;
            if (d <= 6) {
              bandSum += g;
              bandN++;
            } else if (d >= 24) {
              farSum += g;
              farN++;
            }
          }
        }
      }
      const band = bandSum / bandN;
      const far = farSum / farN;
      const ratio = band / Math.max(far, 1e-6);
      checks.push(
        evaluate('the-gradient-energy-along-the-bisector-is-not-a-seam', () => ({
          ok: bandN > 500 && farN > 2000 && ratio < 1.5,
          measured: {
            bandMeanGradient: +band.toFixed(4),
            farMeanGradient: +far.toFixed(4),
            ratio: +ratio.toFixed(3),
            bandSamples: bandN,
            farSamples: farN,
          },
          expected:
            'ratio under 1.5: the band has no more edge energy than the rest of the pool (a torn lattice scores far higher)',
        }))
      );
      checks.push(
        evaluate('the-pattern-is-not-empty', () => ({
          ok: far > 0.05,
          measured: { farMeanGradient: far },
          expected: 'drops exist away from the seam, so a low band energy is not just an empty picture',
        }))
      );
      const artifact = await saveCanvasPng(
        ctx.runId,
        'corner-gain.png',
        cropCanvas(lastFrame2, p.x0 - 20, p.y0 - 20, p.x1 + 20, p.y1 + 20, 3, 'corner gain, sliders only')
      );
      return {
        checks,
        calibration,
        artifacts: artifact ? [artifact] : [],
        inputs: { pool: p },
        stats: { band, far, ratio },
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════════
  scenarios.set('intensity-ladder', {
    name: 'intensity-ladder',
    summary:
      'Drizzle to storm on the real material: how much of the lit picture the water changes grows with the rain, ' +
      'and a storm costs the light only a little. Saves a montage of the rungs.',
    async run(ctx) {
      const checks = [];
      let calibration = 'OK';
      let dry;
      try {
        dry = await calibrated(true);
      } catch (err) {
        calibration = 'FAILED';
        checks.push(check({ id: 'orientation-calibrated', status: 'UNMEASURED', measured: String(err.message) }));
        return { checks, calibration, inputs: {}, stats: {} };
      }
      const levels = [0.05, 0.2, 0.4, 0.7, 1.0];
      const frames = [];
      const stats = { dry: litStats(dry), rungs: [] };
      for (const r of levels) {
        const bytes = await renderWith({ rain01: r, wet01: Math.min(1, r * 1.6) });
        frames.push(bytes);
        const lit = litStats(bytes);
        stats.rungs.push({
          rain01: r,
          changedFraction: +changedFraction(dry, bytes).toFixed(4),
          meanRatio: +(lit.mean / stats.dry.mean).toFixed(4),
        });
      }
      const fr = stats.rungs.map((s) => s.changedFraction);
      checks.push(
        evaluate('more-rain-changes-more-of-the-picture', () => {
          let mono = true;
          for (let i = 1; i < fr.length; i++) if (fr[i] < fr[i - 1] - 0.002) mono = false;
          return {
            ok: mono && fr[fr.length - 1] > fr[0] * 2,
            measured: fr,
            expected: 'monotone non-decreasing, and the storm well above the drizzle',
          };
        })
      );
      checks.push(
        evaluate('drizzle-is-light', () => ({
          ok: fr[0] < 0.2,
          measured: fr[0],
          expected: 'a drizzle touches under 20% of the lit pixels',
        }))
      );
      checks.push(
        evaluate('a-storm-costs-the-light-only-a-little', () => ({
          ok: stats.rungs[4].meanRatio > 0.75 && stats.rungs[4].meanRatio < 1.1,
          measured: stats.rungs[4].meanRatio,
          expected: 'mean lit brightness between 0.75 and 1.1 of dry: variable dimming, not blackout',
        }))
      );
      const artifact = await saveCanvasPng(
        ctx.runId,
        'ladder.png',
        montage(
          [
            cropCanvas(dry, 320, 700, 704, 860, 2, 'dry'),
            ...frames.map((f, i) => cropCanvas(f, 320, 700, 704, 860, 2, `rain ${levels[i]}`)),
          ],
          2
        )
      );
      return { checks, calibration, artifacts: artifact ? [artifact] : [], inputs: { levels }, stats };
    },
  });

  // ═══════════════════════════════════════════════════════════════════════
  scenarios.set('cookie-tier-rain', {
    name: 'cookie-tier-rain',
    summary: 'The no-glass build (one mask tap): rain still shows, by displacing the mask read directly.',
    async run(ctx) {
      const checks = [];
      let calibration = 'OK';
      let dry;
      try {
        dry = await calibrated(false);
      } catch (err) {
        calibration = 'FAILED';
        checks.push(check({ id: 'orientation-calibrated', status: 'UNMEASURED', measured: String(err.message) }));
        return { checks, calibration, inputs: {}, stats: {} };
      }
      const wet = await renderWith({ glass: false, rain01: 0.7, wet01: 1 });
      const frac = changedFraction(dry, wet);
      checks.push(
        evaluate('rain-shows-without-the-glass-subgraph', () => ({
          ok: frac > 0.01 && frac < 0.7,
          measured: { changedFraction: frac },
          expected: 'between 1% and 70% of the lit pixels change',
        }))
      );
      const artifact = await saveCanvasPng(
        ctx.runId,
        'cookie-tier.png',
        montage([cropCanvas(dry, 320, 700, 704, 860, 2, 'dry'), cropCanvas(wet, 320, 700, 704, 860, 2, 'rain 0.7')], 1)
      );
      return {
        checks,
        calibration,
        artifacts: artifact ? [artifact] : [],
        inputs: {},
        stats: { changedFraction: frac },
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════════
  scenarios.set('weather-never-rebuilds', {
    name: 'weather-never-rebuilds',
    summary:
      'Sweeps the rain amount, the wind, the clocks, the look dials, AND rewrites the flow field in place, while ' +
      'counting compiled pipelines. A weather change must be uniform writes and texture bytes, never a shader rebuild.',
    async run() {
      const checks = [];
      let calibration = 'OK';
      try {
        await calibrated(true);
      } catch (err) {
        calibration = 'FAILED';
        checks.push(check({ id: 'orientation-calibrated', status: 'UNMEASURED', measured: String(err.message) }));
      }
      const first = await renderWith({ rain01: 0.5, wet01: 0.8 });
      const afterFirst = pipelineCount();
      const seen = [litStats(first).mean];
      const texturesBefore = [flowDirs, flowAux];
      for (const r of [0, 0.2, 0.9, 1, 0.3]) {
        const b = await renderWith({
          rain01: r,
          wet01: Math.min(1, r * 1.6),
          clock: 10 + r * 50,
          slideClock: 5 + r * 30,
          windSpeed01: r,
          windDirDeg: r * 300,
          gust01: r,
        });
        seen.push(litStats(b).mean);
      }
      const dials = await renderWith({
        look: {
          ...state.look,
          dropScalePx: 4,
          refraction: 1.8,
          caustic: 1.5,
          rimDarken: 0.8,
          trail: 1,
          projectionStretch: 0.9,
        },
      });
      seen.push(litStats(dials).mean);
      const afterSweep = pipelineCount();
      deriveFlow(160);
      const rewritten = await renderWith({ rain01: 0.7, wet01: 1 });
      seen.push(litStats(rewritten).mean);
      const afterRewrite = pipelineCount();
      checks.push(
        evaluate('weather-and-dial-changes-compile-no-pipeline', () => ({
          ok: afterFirst !== null && afterSweep === afterFirst,
          measured: { afterFirstDraw: afterFirst, afterSweep },
          expected: 'identical pipeline counts: a weather change is a uniform write',
        }))
      );
      checks.push(
        evaluate('rewriting-the-flow-textures-in-place-compiles-no-pipeline', () => ({
          ok: afterRewrite === afterFirst && texturesBefore[0] === flowDirs && texturesBefore[1] === flowAux,
          measured: {
            afterRewrite,
            sameTextureObjects: texturesBefore[0] === flowDirs && texturesBefore[1] === flowAux,
          },
          expected: 'same texture objects, same pipeline count',
        }))
      );
      checks.push(
        evaluate('the-sweep-really-changed-the-picture', () => ({
          ok: new Set(seen.map((v) => v.toFixed(2))).size >= 4,
          measured: seen.map((v) => +v.toFixed(2)),
          expected: 'the pushes took effect (otherwise "no pipeline" proves nothing)',
        }))
      );
      deriveFlow(48);
      return { checks, calibration, inputs: {}, stats: { afterFirst, afterSweep, afterRewrite } };
    },
  });

  /**
   * DIAGNOSTIC: the GPU's gain and offset against the twin's over a world rectangle, as arrays, for one weather.
   * The parity scenario summarises this; this lets a person look at the actual numbers around one drop.
   * @param {object} cfg - state overrides (rain01, wet01, clock, slideClock, wind...), plus `override`.
   * @param {{x0:number,y0:number,x1:number,y1:number}} region
   * @returns {Promise<{w:number,h:number,gpu:Float32Array,twin:Float32Array}>} 3 floats per pixel: gain, ox, oy.
   */
  async function compareRegion(cfg, region) {
    if (orientation === null) calibrate(await renderWith({ rain01: 0, wet01: 0 }));
    const bytes = await renderWith({ ...cfg, debugChannel: DEBUG_RAIN_DROPS });
    const frame = lastFrame;
    const look = { ...state.look, ...(cfg.look ?? {}) };
    const w = region.x1 - region.x0;
    const h = region.y1 - region.y0;
    const gpu = new Float32Array(w * h * 3);
    const twin = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const wx = region.x0 + x;
        const wy = region.y0 + y;
        const i = idx(wx, wy);
        const o = (y * w + x) * 3;
        gpu[o] = (bytes[i] / 255) * 2;
        gpu[o + 1] = (bytes[i + 1] / 255 - 0.5) * 2 * RAIN_TUNE.maxOffsetPx;
        gpu[o + 2] = (bytes[i + 2] / 255 - 0.5) * 2 * RAIN_TUNE.maxOffsetPx;
        const t = evalWindowRainPixel({
          x: wx + 0.5,
          y: wy + 0.5,
          frame,
          look,
          // `renderWith` has already restored the state, so the clocks this frame was drawn with are the cfg's.
          clock: cfg.clock ?? state.clock,
          slideClock: cfg.slideClock ?? state.slideClock,
          flow: sampleWindowRainField(field, wx + 0.5, wy + 0.5),
          viewSpanPx: DIM,
          windShiftX: cfg.windShift?.[0] ?? state.windShift[0],
          windShiftY: cfg.windShift?.[1] ?? state.windShift[1],
        });
        twin[o] = t.gain;
        twin[o + 1] = t.offsetX;
        twin[o + 2] = t.offsetY;
      }
    }
    return { w, h, gpu, twin };
  }

  const bench = {
    name: 'window-rain',
    title: 'Window rain - drops on the glass, running down toward the wall',
    rung: 1,
    summary:
      'Rain on the window light, on a real WebGPU device. A synthetic house with a pool of window light on each ' +
      'wall and one at a corner; the real material, the real rain handle and the real flow-field derivation. ' +
      'Proves the shader against its JS twin, that water runs toward each wall, that corners do not tear, that a ' +
      'dry pane is unchanged and that weather never rebuilds a pipeline.',
    params: {
      rain01: 'number 0..1, how hard it is raining',
      wet01: 'number 0..1, how wet the glass already is',
      look: 'the rain dials (WINDOW_RAIN_DEFAULTS shape)',
    },
    scenarios,
    checkIds: [
      'dry-rain-handle-is-pixel-identical-to-no-rain-at-the-glass-tier',
      'dry-rain-handle-is-pixel-identical-to-no-rain-at-the-cookie-tier',
      'south-window-runs-south',
      'gpu-matches-the-twin-gusty-storm',
      'south-drops-travel-toward-the-south-wall',
      'the-gradient-energy-along-the-bisector-is-not-a-seam',
      'weather-and-dial-changes-compile-no-pipeline',
    ],
    ready: () => true,
    async runScenario(scenario, ctx) {
      return scenario.run(ctx);
    },

    // ── THE LIVE SURFACE, for looking at rather than asserting on ──────────
    state,
    pools: POOLS,
    channels: WINDOW_DEBUG_CHANNELS,
    async refresh(label) {
      const bytes = await renderFrame();
      if (orientation === null) calibrate(await renderWith({ rain01: 0, wet01: 0, debugChannel: 0 }));
      paint(
        bytes,
        label ??
          `rain=${state.rain01} wet=${state.wet01} t=${state.clock.toFixed(1)} slide=${state.slideClock.toFixed(1)} wind=${state.windSpeed01}@${state.windDirDeg} ch=${state.debugChannel}`
      );
      return litStats(bytes);
    },
    compareRegion,
    /** Re-derive the flow field (the author nudged Corner blend), in place. */
    setEase(px) {
      deriveFlow(px);
    },
    /** THE GENERATED WGSL of whatever is attached: the proof of what the rain costs in shader size. */
    async dumpShader() {
      await renderFrame();
      const s = await renderer.debug.getShaderAsync(scene, camera, mesh);
      return { vertex: s.vertexShader, fragment: s.fragmentShader };
    },
    /** Rebuild with or without the rain subgraph / glass: `dumpShader()` either side is the A/B. */
    rebuild({ glass = true, withRain = true } = {}) {
      state.glass = !!glass;
      state.withRain = !!withRain;
      scene = null;
      buildScene();
      return `rebuilt with glass=${state.glass} rain=${state.withRain}`;
    },
    /** TEST/DIAGNOSTIC: the derived field's facet levels and counts. */
    describeFlow() {
      ensureFixture();
      return { levels: field.levels.map((a) => +a.toFixed(1)), stats: field.stats };
    },
  };

  registerBench(bench);
  return bench;
}
