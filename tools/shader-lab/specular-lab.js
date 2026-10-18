/**
 * SPECULAR LOOK LAB — the REAL shine material, over a REAL map's own `_Specular`
 * file, with the map's own art underneath, saved as PNGs you can read.
 *
 * ============================================================================
 * WHAT THIS IS FOR, AND WHAT `bench-specular.js` ALREADY IS
 * ============================================================================
 * `bench-specular.js` answers "which factor of the composite is zero" on a
 * synthetic 512² plate. This page answers a different question: **what does the
 * shimmer FIELD actually look like** — its blobs, its streaks, and above all its
 * EDGES — at the resolution and zoom a player sees, on a real authored mask?
 * It was built to hunt hard edges in the shimmer ("a hard edge is ugly, never
 * allow one"), and it keeps the numbers that make "soft" a measurement rather
 * than an opinion (`edgeReport`).
 *
 * Nothing here is transcribed from `src/`: it imports the real
 * `buildSpecularSurfaceMaterial`, the real island bake, the real mask loader
 * (`vt/mask-image.js`, at the production `SPECULAR_MASK_IMAGE_SCALE`) and the
 * same neutral tonemap the shader-lab bench uses. The only thing built here is
 * the plumbing the viewer would normally provide (a quad, a camera, an illum
 * buffer) and the base art the shine is added onto.
 *
 * ============================================================================
 * DRIVING IT (all headless-safe — nothing is presented to a surface)
 * ============================================================================
 *   /tools/shader-lab/specular-lab.html?w=1024&h=1024&run=spec-before
 *
 *   await specLab.ready
 *   await specLab.loadMap({ maskUrl, artUrl })      // a real map
 *   await specLab.loadSlab({ size: 4096 })          // OR: all-metal, no mask edges
 *   await specLab.shot({ name: 'goblin-a', cx: 1500, cy: 1500, scale: 1 })
 *   await specLab.shot({ name: 'field', channel: 'shimmer', base: 'none' })
 *   specLab.setParam('shimmerGain', 8)              // any surface.setXxx
 *   specLab.setLayer(2, 'softness', 0.6)            // any surface.setLayerXxx
 *
 * Frames land in `tools/shader-lab/runs/<run>/<name>.png` (served by
 * `serve.mjs`). Rendering is on-demand — there is no rAF loop to starve when the
 * browser pane is hidden.
 *
 * @module tools/shader-lab/specular-lab
 */
import * as THREE from '../../src/vendor/three/three.webgpu.js';
import {
  buildSpecularSurfaceMaterial,
  SPECULAR_MASK_IMAGE_SCALE,
  SPECULAR_LAYER_COUNT,
} from '../../src/effects/specular/specular-render.js';
import { buildSpecularIslandPack } from '../../src/effects/specular/specular-islands.js';
import { SPECULAR_DEBUG_CHANNELS } from '../../src/effects/specular/specular.js';
import { buildWorldSpaceOutdoorsGate } from '../../src/effects/lighting/environmental-light.js';
import { computeCameraFrustum, QUAD_UVS, QUAD_INDICES, buildQuadPositions } from '../../src/scene/world-quad.js';
import { loadMaskImageTexture } from '../../src/vt/mask-image.js';
import { neutralToneMap } from './bench-specular.js';

const query = new URLSearchParams(location.search);
const W = Math.max(64, Number(query.get('w') || 1024));
const H = Math.max(64, Number(query.get('h') || 1024));
const RUN = (query.get('run') || 'spec').replace(/[^A-Za-z0-9._-]/g, '-');
const statusEl = document.getElementById('status');
const viewCanvas = document.getElementById('view');
viewCanvas.width = W;
viewCanvas.height = H;

const log = (msg) => {
  console.log('[spec-lab]', msg);
  statusEl.textContent += `\n${msg}`;
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** IEEE-754 binary16 → float, as a 64K lookup (a frame is millions of these). */
const HALF_LUT = (() => {
  const lut = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = (h & 0x8000) >> 15;
    const e = (h & 0x7c00) >> 10;
    const f = h & 0x03ff;
    const sign = s ? -1 : 1;
    if (e === 0) lut[h] = sign * Math.pow(2, -14) * (f / 1024);
    else if (e === 0x1f) lut[h] = f ? NaN : sign * Infinity;
    else lut[h] = sign * Math.pow(2, e - 15) * (1 + f / 1024);
  }
  return lut;
})();

const srgbEotf = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const srgbOetf = (l) => (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// ---------------------------------------------------------------------------
// The device, the target, the material
// ---------------------------------------------------------------------------

const renderer = new THREE.WebGPURenderer({ antialias: false });

let world = { minX: 0, minY: 0, maxX: 3000, maxY: 3000 };
const view = { cx: 1500, cy: 1500, scale: 1 };
const state = {
  timeMs: 0,
  channel: 'off',
  orientationFlip: false,
  mask: null,
  islands: null,
  art: null,
  tier: query.get('tier') != null ? Number(query.get('tier')) : undefined,
};

const { uniform, vec4, texture } = THREE.TSL;
const uViewRect = uniform(vec4(0, 0, 1, 1));
const uOutdoorsRect = uniform(vec4(0, 0, 1, 1));
const uTimeMs = uniform(0);

/** @param {Uint8Array} data @param {number} w @param {number} h @param {boolean} nearest */
function makeTex(data, w, h, nearest = false) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  const f = nearest ? THREE.NearestFilter : THREE.LinearFilter;
  t.minFilter = f;
  t.magFilter = f;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

const solidTex = (r, g, b, a) => makeTex(new Uint8Array([r, g, b, a]), 1, 1);

let maskTexture = solidTex(0, 0, 0, 255);
let islandPackTexture = makeTex(new Uint8Array([191, 128, 0, 0]), 1, 1, true);
// The screen-space light buffer — W×H, rewritten per shot (row 0 = view top).
const illumData = new Uint8Array(W * H * 4);
const illumTexture = makeTex(illumData, W, H);
const outdoorsData = new Uint8Array([0, 0, 0, 255]);
const outdoorsTexture = makeTex(outdoorsData, 1, 1);

let surface = null;
let mesh = null;
let rt = null;
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
const scene = new THREE.Scene();
const geometry = new THREE.BufferGeometry();
geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
geometry.setIndex(Array.from(QUAD_INDICES));
geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));

function viewRect() {
  const hw = W / 2 / view.scale;
  const hh = H / 2 / view.scale;
  return { minX: view.cx - hw, minY: view.cy - hh, maxX: view.cx + hw, maxY: view.cy + hh };
}

function setQuad(rect) {
  geometry.getAttribute('position').array.set(
    buildQuadPositions([
      { x: rect.minX, y: rect.minY },
      { x: rect.maxX, y: rect.minY },
      { x: rect.maxX, y: rect.maxY },
      { x: rect.minX, y: rect.maxY },
    ])
  );
  geometry.getAttribute('position').needsUpdate = true;
}

const channelNumber = (id) => SPECULAR_DEBUG_CHANNELS.find((c) => c.id === id)?.n ?? 0;

// ---------------------------------------------------------------------------
// Inputs: a real map, or an all-metal slab
// ---------------------------------------------------------------------------

/** Swap the mask (+ its island pack) in, exactly the subsystem's own sequence. */
function adoptMask({ texture: tex, data, width, height, rect, label, islandSpread = 2 }) {
  maskTexture?.dispose?.();
  maskTexture = tex;
  surface.setMaskTexture(tex);
  world = rect;
  surface.setMaskUvBounds({ minU: 0, minV: 0, maxU: 1, maxV: 1 });
  setQuad(world);
  let islandReport = null;
  try {
    const pack = buildSpecularIslandPack({ rgba: data, width, height, spread: islandSpread });
    islandPackTexture?.dispose?.();
    islandPackTexture = makeTex(pack.data, pack.w, pack.h, true);
    surface.setIslandPackTexture(islandPackTexture);
    surface.setIslandBakeStatus(pack.islandCount > 0 ? 2 : 1);
    islandReport = { grid: `${pack.w}x${pack.h}`, islands: pack.islandCount, labelledTexels: pack.labelledTexels };
  } catch (err) {
    surface.setIslandBakeStatus(0);
    islandReport = { error: String(err?.message ?? err) };
  }
  state.mask = { label, width, height, rect };
  state.islands = islandReport;
  view.cx = (rect.minX + rect.maxX) / 2;
  view.cy = (rect.minY + rect.maxY) / 2;
  log(
    `mask ${label}: ${width}x${height}  world ${rect.maxX - rect.minX}x${rect.maxY - rect.minY}  islands ${JSON.stringify(islandReport)}`
  );
}

/**
 * Load a real `_Specular` file through the production loader and (optionally)
 * the map's own art. The world rect is the art's own pixel size at 1:1, which is
 * what a 100-px-grid Foundry scene with no padding gives.
 * @param {{maskUrl: string, artUrl?: string, worldW?: number, worldH?: number, islandSpread?: number}} args
 */
async function loadMap({ maskUrl, artUrl = null, worldW = 0, worldH = 0, islandSpread = 2 }) {
  await ready;
  const loaded = await loadMaskImageTexture({ url: maskUrl, THREE, scale: SPECULAR_MASK_IMAGE_SCALE, channels: 'rgb' });
  if (!loaded) throw new Error(`mask failed to load: ${maskUrl}`);
  const ww = worldW || loaded.nativeWidth;
  const wh = worldH || loaded.nativeHeight;
  adoptMask({
    texture: loaded.texture,
    data: loaded.data,
    width: loaded.width,
    height: loaded.height,
    rect: { minX: 0, minY: 0, maxX: ww, maxY: wh },
    label: maskUrl.split('/').pop(),
    islandSpread,
  });
  if (artUrl) await loadArt(artUrl);
  return { mask: state.mask, islands: state.islands, art: state.art && { w: state.art.w, h: state.art.h } };
}

/**
 * An all-metal slab: every texel painted, so there is NO mask edge anywhere in
 * view and every pixel of the picture is the shimmer field itself. The right
 * input for judging blobs and streaks without the silhouette confounding it.
 * @param {{size?: number, rgb?: number[], texels?: number}} [args]
 */
async function loadSlab({ size = 4096, rgb = [232, 178, 64], texels = 64 } = {}) {
  await ready;
  const data = new Uint8Array(texels * texels * 4);
  for (let i = 0; i < texels * texels; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  adoptMask({
    texture: makeTex(data, texels, texels),
    data,
    width: texels,
    height: texels,
    rect: { minX: 0, minY: 0, maxX: size, maxY: size },
    label: `slab-${size}`,
  });
  state.art = null;
  return { mask: state.mask };
}

async function loadArt(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`art fetch ${res.status}: ${url}`);
  const bmp = await createImageBitmap(await res.blob());
  state.art = { bmp, w: bmp.width, h: bmp.height, url };
  log(`art ${url.split('/').pop()}: ${bmp.width}x${bmp.height}`);
}

// ---------------------------------------------------------------------------
// The light buffer + the base the shine is added onto
// ---------------------------------------------------------------------------

/**
 * Per-pixel light, gamma-space (what `buf:scene.illum` carries). `flat` is a
 * uniform level; `pool` is a lamp: `inner` at the centre falling to `outer`.
 * @param {{kind?: 'flat'|'pool', level?: number, cx?: number, cy?: number, radius?: number, inner?: number, outer?: number}} spec
 * @returns {Float32Array} W*H levels
 */
function fillIllum(spec) {
  const levels = new Float32Array(W * H);
  const v = viewRect();
  const kind = spec.kind ?? 'flat';
  for (let y = 0; y < H; y++) {
    const wy = v.minY + ((y + 0.5) / H) * (v.maxY - v.minY);
    for (let x = 0; x < W; x++) {
      const wx = v.minX + ((x + 0.5) / W) * (v.maxX - v.minX);
      let lv = spec.level ?? 0.6;
      if (kind === 'pool') {
        const d = Math.hypot(wx - spec.cx, wy - spec.cy) / spec.radius;
        const t = clamp01(1 - d);
        const s = t * t * (3 - 2 * t);
        lv = (spec.outer ?? 0.2) + ((spec.inner ?? 0.95) - (spec.outer ?? 0.2)) * s;
      }
      levels[y * W + x] = lv;
      const i = (y * W + x) * 4;
      const b = Math.round(clamp01(lv) * 255);
      illumData[i] = b;
      illumData[i + 1] = b;
      illumData[i + 2] = b;
      illumData[i + 3] = 255;
    }
  }
  illumTexture.needsUpdate = true;
  return levels;
}

/** The map art resampled to the current view, sRGB 0..1, 3 floats per pixel. */
function artToView() {
  const out = new Float32Array(W * H * 3);
  if (!state.art) return out;
  const c = new OffscreenCanvas(W, H);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  const v = viewRect();
  const sx = ((v.minX - world.minX) / (world.maxX - world.minX)) * state.art.w;
  const sy = ((v.minY - world.minY) / (world.maxY - world.minY)) * state.art.h;
  const sw = ((v.maxX - v.minX) / (world.maxX - world.minX)) * state.art.w;
  const sh = ((v.maxY - v.minY) / (world.maxY - world.minY)) * state.art.h;
  g.drawImage(state.art.bmp, sx, sy, sw, sh, 0, 0, W, H);
  const px = g.getImageData(0, 0, W, H).data;
  for (let i = 0; i < W * H; i++) {
    out[i * 3] = px[i * 4] / 255;
    out[i * 3 + 1] = px[i * 4 + 1] / 255;
    out[i * 3 + 2] = px[i * 4 + 2] / 255;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Render + readback
// ---------------------------------------------------------------------------

async function renderRaw(channel) {
  if (!rt) {
    rt = new THREE.RenderTarget(W, H, {
      // HalfFloat, matching `scene.lit` — an 8-bit target would clip every glint
      // peak this effect pushes past 1.0 and report the clip as the shader's answer.
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
    });
  }
  const v = viewRect();
  uViewRect.value.set(v.minX, v.minY, v.maxX, v.maxY);
  uOutdoorsRect.value.set(world.minX, world.minY, world.maxX, world.maxY);
  uTimeMs.value = state.timeMs;
  surface.setViewCentre(view.cx, view.cy);
  const n = channel === 'off' ? 0 : channelNumber(channel);
  surface.setDebugChannel(n);
  mesh.material = n > 0 ? surface.debugMaterial : surface.specularMaterial;
  const f = computeCameraFrustum(v);
  camera.left = f.left;
  camera.right = f.right;
  camera.top = f.top;
  camera.bottom = f.bottom;
  camera.updateProjectionMatrix();

  const prevTarget = renderer.getRenderTarget();
  const prevClear = new THREE.Color();
  renderer.getClearColor(prevClear);
  const prevAlpha = renderer.getClearAlpha();
  // The shine is ADDITIVE; render it onto black and add the base in JS (exact
  // for an additive blend, and it keeps the base out of the shader entirely).
  renderer.setClearColor(new THREE.Color(0, 0, 0), 1);
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
}

/** @returns {Promise<Float32Array>} RGBA floats, row 0 = view top. */
async function readFrame() {
  const buf = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H);
  const raw = buf instanceof Promise ? await buf : buf;
  const u16 = raw instanceof Uint16Array ? raw : new Uint16Array(raw.buffer ?? raw);
  const out = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const src = state.orientationFlip ? H - 1 - y : y;
    const so = src * W * 4;
    const dO = y * W * 4;
    for (let i = 0; i < W * 4; i++) out[dO + i] = HALF_LUT[u16[so + i]];
  }
  return out;
}

/** Orientation, VERIFIED not assumed: light only the top-left quarter and look. */
async function calibrate() {
  const v = viewRect();
  const savedWorld = world;
  setQuad({ minX: v.minX, minY: v.minY, maxX: (v.minX + v.maxX) / 2, maxY: (v.minY + v.maxY) / 2 });
  state.orientationFlip = false;
  await renderRaw('quad');
  let frame = await readFrame();
  const at = (fx, fy) => frame[(Math.floor(H * fy) * W + Math.floor(W * fx)) * 4];
  if (!(at(0.25, 0.25) > 0.5 && at(0.25, 0.75) < 0.5)) {
    state.orientationFlip = true;
    frame = await readFrame();
  }
  const ok = at(0.25, 0.25) > 0.5 && at(0.25, 0.75) < 0.5 && at(0.75, 0.25) < 0.5;
  setQuad(savedWorld);
  log(`orientation: flip=${state.orientationFlip} -> ${ok ? 'OK' : 'FAILED'}`);
  return ok;
}

// ---------------------------------------------------------------------------
// A shot
// ---------------------------------------------------------------------------

/**
 * Render one frame, compose it over the map art, save the PNG, return numbers.
 *
 * @param {object} [opts]
 * @param {string} [opts.name]      file name (no extension)
 * @param {number} [opts.cx] @param {number} [opts.cy] @param {number} [opts.scale]
 *   the view: world centre, and screen px per world px (1 = 1:1).
 * @param {number} [opts.timeMs]
 * @param {string} [opts.channel]   'off' (the effect) or a debug channel id.
 * @param {'art'|'flat'|'none'} [opts.base] what the shine is added onto.
 * @param {number} [opts.flat]      linear grey for base 'flat'.
 * @param {object} [opts.illum]     `fillIllum`'s spec.
 * @param {number} [opts.gain]      display gain for debug channels.
 * @param {boolean} [opts.save]
 * @param {boolean} [opts.metrics]  include `edgeReport` + a gradient PNG.
 */
async function shot(opts = {}) {
  await ready;
  const o = {
    name: 'shot',
    cx: view.cx,
    cy: view.cy,
    scale: view.scale,
    timeMs: state.timeMs,
    channel: 'off',
    base: state.art ? 'art' : 'flat',
    flat: 0.2,
    illum: { kind: 'flat', level: 0.6 },
    gain: 1,
    save: true,
    metrics: false,
    ...opts,
  };
  view.cx = o.cx;
  view.cy = o.cy;
  view.scale = o.scale;
  state.timeMs = o.timeMs;

  const levels = fillIllum(o.illum);
  await renderRaw(o.channel);
  const frame = await readFrame();

  const art = o.base === 'art' ? artToView() : null;
  const disp = new Uint8ClampedArray(W * H * 4);
  const luma = new Float32Array(W * H);
  const shineLuma = new Float32Array(W * H);
  const isEffect = o.channel === 'off';
  let peak = 0;
  for (let i = 0; i < W * H; i++) {
    let r = frame[i * 4];
    let g = frame[i * 4 + 1];
    let b = frame[i * 4 + 2];
    if (!(r === r)) r = 0; // NaN guard — a NaN would poison every metric below
    if (!(g === g)) g = 0;
    if (!(b === b)) b = 0;
    if (isEffect) {
      let br;
      let bg;
      let bb;
      if (o.base === 'art') {
        const lv = levels[i];
        br = srgbEotf(clamp01(art[i * 3] * lv));
        bg = srgbEotf(clamp01(art[i * 3 + 1] * lv));
        bb = srgbEotf(clamp01(art[i * 3 + 2] * lv));
      } else if (o.base === 'flat') {
        br = bg = bb = o.flat;
      } else {
        br = bg = bb = 0;
      }
      const sr = r;
      const sg = g;
      const sb = b;
      [r, g, b] = neutralToneMap([sr + br, sg + bg, sb + bb]);
      if (o.base === 'art') {
        // What the SHINE alone added, in display luma: the art's own ink lines
        // and edges cancel, so `edgeReport` below measures the shimmer and not
        // the painting underneath it.
        const [tr, tg, tb] = neutralToneMap([br, bg, bb]);
        shineLuma[i] =
          0.2126 * (srgbOetf(clamp01(r)) - srgbOetf(clamp01(tr))) +
          0.7152 * (srgbOetf(clamp01(g)) - srgbOetf(clamp01(tg))) +
          0.0722 * (srgbOetf(clamp01(b)) - srgbOetf(clamp01(tb)));
      }
    } else {
      r *= o.gain;
      g *= o.gain;
      b *= o.gain;
    }
    const er = srgbOetf(clamp01(r));
    const eg = srgbOetf(clamp01(g));
    const eb = srgbOetf(clamp01(b));
    disp[i * 4] = Math.round(er * 255);
    disp[i * 4 + 1] = Math.round(eg * 255);
    disp[i * 4 + 2] = Math.round(eb * 255);
    disp[i * 4 + 3] = 255;
    luma[i] = 0.2126 * er + 0.7152 * eg + 0.0722 * eb;
    if (frame[i * 4] > peak) peak = frame[i * 4];
  }
  viewCanvas.getContext('2d').putImageData(new ImageData(disp, W, H), 0, 0);

  const result = {
    name: o.name,
    view: { cx: o.cx, cy: o.cy, scale: o.scale },
    timeMs: o.timeMs,
    channel: o.channel,
    peakRawR: peak,
  };
  if (o.save) result.saved = await savePng(viewCanvas, `${o.name}.png`);
  if (o.metrics) {
    // Over a real map the metric runs on the shine's own contribution (art cancelled).
    const measured = isEffect && o.base === 'art' ? shineLuma : luma;
    result.edges = edgeReport(measured);
    if (o.save) result.gradientSaved = await saveGradient(measured, `${o.name}.grad.png`);
  }
  return result;
}

/**
 * Tile the map with views and report `edgeReport` for each — the way to FIND the
 * worst place on a real map rather than to guess at one. Nothing is saved.
 * @param {{scale?: number, x0?: number, y0?: number, step?: number, nx?: number, ny?: number, timeMs?: number}} [args]
 * @returns {Promise<Array<{cx: number, cy: number, edges: object}>>}
 */
async function scan({ scale = 0.5, x0, y0, step, nx = 4, ny = 4, timeMs = 0 } = {}) {
  await ready;
  const spanX = W / scale;
  const spanY = H / scale;
  const sx = step ?? spanX;
  const startX = x0 ?? world.minX + spanX / 2;
  const startY = y0 ?? world.minY + spanY / 2;
  const out = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const cx = startX + i * sx;
      const cy = startY + j * (step ?? spanY);
      const r = await shot({ name: 'scan', cx, cy, scale, timeMs, save: false, metrics: true });
      out.push({ cx: Math.round(cx), cy: Math.round(cy), edges: r.edges });
    }
  }
  return out;
}

/**
 * GPU cost of the pass, wall-clock over a back-to-back burst, on the current
 * mask at the current view. Run it on an ALL-METAL slab (`loadSlab`) for the
 * per-pixel cost with nothing gated off; scale by your real metal coverage.
 * The first frames compile the pipeline and are excluded.
 * @param {{frames?: number, warm?: number}} [args]
 */
async function bench({ frames = 40, warm = 6 } = {}) {
  await ready;
  const device = renderer.backend.device;
  fillIllum({ kind: 'flat', level: 0.6 });
  for (let i = 0; i < warm; i++) await renderRaw('off');
  await device.queue.onSubmittedWorkDone();
  const samples = [];
  for (let burst = 0; burst < 5; burst++) {
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) await renderRaw('off');
    await device.queue.onSubmittedWorkDone();
    samples.push((performance.now() - t0) / frames);
  }
  samples.sort((a, b) => a - b);
  return {
    W,
    H,
    frames,
    msPerFrame: { min: +samples[0].toFixed(3), median: +samples[2].toFixed(3), max: +samples[4].toFixed(3) },
  };
}

async function savePng(canvas, file) {
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  const r = await fetch(`/__lab/artifact?run=${encodeURIComponent(RUN)}&file=${encodeURIComponent(file)}`, {
    method: 'POST',
    body: blob,
  });
  return r.json();
}

// ---------------------------------------------------------------------------
// HOW HARD IS THE EDGE — the numbers
// ---------------------------------------------------------------------------

/**
 * Per-pixel display-luma STEP statistics over a frame, 4-neighbour. A soft edge
 * spreads its contrast over many pixels, so its per-pixel step is small; a hard
 * edge dumps it into one or two. `max` and the high percentiles are the numbers
 * that name a hard edge; `hardFrac(T)` is the share of pixels whose step to a
 * neighbour exceeds T display units (T=0.10 is ~25/255 per pixel — visibly a
 * line, not a gradient).
 * @param {Float32Array} luma W*H display luma in 0..1
 */
function edgeReport(luma) {
  const steps = new Float32Array((W - 1) * (H - 1));
  let n = 0;
  let max = 0;
  let sum = 0;
  let over10 = 0;
  let over20 = 0;
  let over35 = 0;
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const i = y * W + x;
      const s = Math.max(Math.abs(luma[i + 1] - luma[i]), Math.abs(luma[i + W] - luma[i]));
      steps[n++] = s;
      sum += s;
      if (s > max) max = s;
      if (s > 0.1) over10++;
      if (s > 0.2) over20++;
      if (s > 0.35) over35++;
    }
  }
  const sorted = steps.slice(0, n).sort();
  const pct = (p) => sorted[Math.min(n - 1, Math.floor(p * n))];
  return {
    max: +max.toFixed(4),
    p99999: +pct(0.99999).toFixed(4),
    p9999: +pct(0.9999).toFixed(4),
    p999: +pct(0.999).toFixed(4),
    p99: +pct(0.99).toFixed(4),
    mean: +(sum / n).toFixed(5),
    over010: over10,
    over020: over20,
    over035: over35,
    px: n,
  };
}

/** A heat image of the per-pixel step: black = smooth, white = a step of >= 0.35. */
async function saveGradient(luma, file) {
  const c = new OffscreenCanvas(W, H);
  const g = c.getContext('2d');
  const img = new ImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const dx = x < W - 1 ? Math.abs(luma[i + 1] - luma[i]) : 0;
      const dy = y < H - 1 ? Math.abs(luma[i + W] - luma[i]) : 0;
      const s = Math.min(1, Math.max(dx, dy) / 0.35);
      const hot = Math.pow(s, 0.6);
      img.data[i * 4] = Math.round(255 * Math.min(1, hot * 2));
      img.data[i * 4 + 1] = Math.round(255 * Math.max(0, hot * 2 - 1));
      img.data[i * 4 + 2] = Math.round(60 * (1 - hot));
      img.data[i * 4 + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const r = await fetch(`/__lab/artifact?run=${encodeURIComponent(RUN)}&file=${encodeURIComponent(file)}`, {
    method: 'POST',
    body: blob,
  });
  return r.json();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const ready = (async () => {
  await renderer.init();
  log(`renderer backend: ${renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL'}  ${W}x${H}  run=${RUN}`);
  const buildArgs = {
    THREE,
    maskTexture,
    islandPackTexture,
    illumTexture,
    depthTexture: null,
    uViewRect,
    uOutdoorsRect,
    outdoorsTexNode: texture(outdoorsTexture),
    buildOutdoorsGate: buildWorldSpaceOutdoorsGate,
    timeMsNode: uTimeMs,
  };
  if (state.tier !== undefined) buildArgs.tier = state.tier;
  surface = buildSpecularSurfaceMaterial(buildArgs);
  mesh = new THREE.Mesh(geometry, surface.specularMaterial);
  mesh.frustumCulled = false;
  scene.add(mesh);
  setQuad(world);
  await calibrate();
  log('specLab ready');
})().catch((err) => {
  log(`INIT FAILED: ${err.stack || err.message}`);
  throw err;
});

window.specLab = {
  ready,
  W,
  H,
  RUN,
  loadMap,
  loadSlab,
  shot,
  scan,
  bench,
  state,
  view,
  edgeReport,
  getWorld: () => world,
  getSurface: () => surface,
  /** Any `surface.setXxx` by its bare name: `setParam('shimmerGain', 8)`. */
  setParam(name, value) {
    const fn = surface[`set${cap(name)}`];
    if (typeof fn !== 'function') throw new Error(`no setter set${cap(name)}`);
    fn(value);
  },
  /** Any per-layer setter: `setLayer(2, 'softness', 0.6)`. */
  setLayer(i, key, value) {
    const fn = surface[`setLayer${cap(key)}`];
    if (typeof fn !== 'function') throw new Error(`no setter setLayer${cap(key)}`);
    fn(i, value);
  },
  layerCount: SPECULAR_LAYER_COUNT,
  channels: SPECULAR_DEBUG_CHANNELS.map((c) => c.id),
  setSun(dx, dy, outdoors01 = 0) {
    surface.setSunDir(dx, dy);
    const v = Math.round(clamp01(outdoors01) * 255);
    outdoorsData.set([v, v, v, 255]);
    outdoorsTexture.needsUpdate = true;
  },
};
