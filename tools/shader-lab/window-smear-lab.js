/**
 * WINDOW SMEAR LAB — the sun's smear of `_Window` light (`window-room-light.js`), rendered through the REAL window
 * material, measured.
 *
 * The author, 2026-11-04: "The _Window effect when it stretches and smears, we get quite a noisy grainy effect, is
 * there no smoother way to do the offset/smear/extension effect?" The smear is 8 cookie reads strung along the sun's
 * throw; this lab renders a mullioned window, one room facing the sun, and a long throw, and reports:
 *   - grain: RMS of a 3x3 Laplacian over the smeared pane, relative to its mean light (dither is all high frequency);
 *   - sharpness: the 10..90% width, in px, of the edge of a glazing bar that runs ALONG the throw (it must stay crisp:
 *     a bar along the sun's line is not smeared by it);
 *   - energy: the total light, so a fix that dims or brightens the beam is caught.
 *
 * `window.smearLab.run({ angleDeg, throwPx, glass, runId, file })` → metrics (and a PNG landed in runs/ when runId).
 * The window is symmetric top-to-bottom, so the readback row order cannot change any number.
 *
 * @module tools/shader-lab/window-smear-lab
 */

import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { saveCanvasPng } from './contract.js';
import { buildWindowSurfaceMaterial } from '../../src/effects/window/window-render.js';
import { createWindowRoomLight, resolveRoomLook } from '../../src/effects/window/window-room-light.js';
import { QUAD_UVS, QUAD_INDICES, buildQuadPositions } from '../../src/scene/index.js';

const W = 1024;
const H = 512;
/** The mask is half the world's resolution, as `WINDOW_MASK_IMAGE_SCALE` loads a real one. */
const MW = W / 2;
const MH = H / 2;
/** The window, world px: two columns of panes, mullions every 50 px, one transom along x through the middle. */
const WIN = { x0: 60, x1: 260, y0: 120, y1: 392 };

const { uniform, vec4 } = THREE.TSL;

function buildMask() {
  const d = new Uint8Array(MW * MH * 4);
  for (let my = 0; my < MH; my++) {
    for (let mx = 0; mx < MW; mx++) {
      const x = (mx + 0.5) * 2;
      const y = (my + 0.5) * 2;
      const inWin = x > WIN.x0 && x < WIN.x1 && y > WIN.y0 && y < WIN.y1;
      const mullion = (x - WIN.x0) % 50 < 8;
      const transom = Math.abs(y - 256) < 6;
      const lit = inWin && !mullion && !transom;
      const i = (my * MW + mx) * 4;
      d[i] = lit ? 255 : 0;
      d[i + 1] = lit ? 240 : 0;
      d[i + 2] = lit ? 205 : 0;
      d[i + 3] = 255;
    }
  }
  return d;
}

function texture1(bytes) {
  const t = new THREE.DataTexture(new Uint8Array(bytes), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

let renderer = null;
let camera = null;
let target = null;
let maskTexture = null;
const built = new Map();

async function ensure() {
  if (renderer) return;
  renderer = new THREE.WebGPURenderer({ antialias: false });
  await renderer.init();
  camera = new THREE.OrthographicCamera(0, W, H, 0, -1000, 1000);
  camera.position.set(0, 0, 100);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  target = new THREE.RenderTarget(W, H, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.NoColorSpace,
  });
  maskTexture = new THREE.DataTexture(buildMask(), MW, MH, THREE.RGBAFormat, THREE.UnsignedByteType);
  maskTexture.colorSpace = THREE.NoColorSpace;
  // As `loadMaskImageTexture({ mipmaps: true })` uploads the real one.
  maskTexture.generateMipmaps = true;
  maskTexture.minFilter = THREE.LinearMipmapLinearFilter;
  maskTexture.anisotropy = 16;
  maskTexture.magFilter = THREE.LinearFilter;
  maskTexture.needsUpdate = true;
}

/** One scene per glass branch (a JS-time branch: a different material). */
function sceneFor(glass) {
  if (built.has(glass)) return built.get(glass);
  // One room over everything, far from any wall, looking out WEST (outlook (−1, 0): g = 0, b = 128).
  const roomLight = createWindowRoomLight({
    THREE,
    roomTexture: texture1([1, 0, 0, 255]),
    fieldTexture: texture1([255, 0, 128, 255]),
  });
  roomLight.setRoomMap({
    roomTexture: texture1([1, 0, 0, 255]),
    fieldTexture: texture1([255, 0, 128, 255]),
    spec: { minX: 0, minY: 0, cols: 1, rows: 1, cellSize: 1024 },
  });
  const surface = buildWindowSurfaceMaterial({
    THREE,
    maskTexture,
    attrTexture: null,
    uViewRect: uniform(vec4(0, 0, W, H)),
    glass,
    roomLight,
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
  geometry.setIndex(Array.from(QUAD_INDICES));
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(
      buildQuadPositions([
        { x: 0, y: 0 },
        { x: W, y: 0 },
        { x: W, y: H },
        { x: 0, y: H },
      ]),
      3
    )
  );
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(geometry, surface.windowMaterial);
  mesh.frustumCulled = false;
  scene.add(mesh);
  surface.setMaskUvBounds({ minU: 0, minV: 0, maxU: 1, maxV: 1 });
  surface.setUvPerWorldPx(1 / W, 1 / H);
  surface.setStrength(1);
  surface.setContrast(1);
  surface.setDaylightTint([1, 1, 1]);
  const entry = { scene, surface, roomLight };
  built.set(glass, entry);
  return entry;
}

const lum = (b, x, y) => {
  const i = (y * W + x) * 4;
  return (b[i] + b[i + 1] + b[i + 2]) / (3 * 255);
};

/** Grain: RMS of the 3x3 Laplacian over a rect, relative to the rect's mean. */
function grain(b, x0, x1, y0, y1) {
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const c = lum(b, x, y);
      const l =
        8 * c -
        (lum(b, x - 1, y - 1) +
          lum(b, x, y - 1) +
          lum(b, x + 1, y - 1) +
          lum(b, x - 1, y) +
          lum(b, x + 1, y) +
          lum(b, x - 1, y + 1) +
          lum(b, x, y + 1) +
          lum(b, x + 1, y + 1));
      s += c;
      s2 += l * l;
      n++;
    }
  }
  const mean = s / n;
  return { mean, grain: Math.sqrt(s2 / n) / Math.max(mean, 1e-6) };
}

/**
 * The transom's edge (it runs along x, the throw's line when the sun is due west): a column profile across it at x,
 * averaged over ±avg px of x, and the 10..90% rise width of its upper edge, px.
 */
function transomEdge(b, x, avg = 6) {
  const prof = [];
  for (let y = 200; y <= 256; y++) {
    let s = 0;
    for (let dx = -avg; dx <= avg; dx++) s += lum(b, x + dx, y);
    prof.push(s / (2 * avg + 1));
  }
  const hi = Math.max(...prof.slice(0, 30));
  const lo = Math.min(...prof);
  const at = (f) => prof.findIndex((v) => v < lo + f * (hi - lo));
  return { width: at(0.1) - at(0.9), contrast: (hi - lo) / Math.max(hi + lo, 1e-6) };
}

async function run({
  strength = 6,
  angleDeg = 0,
  throwPx = 150,
  glass = false,
  look = {},
  runId = null,
  file = null,
} = {}) {
  await ensure();
  const { scene, surface, roomLight } = sceneFor(glass);
  const a = (angleDeg * Math.PI) / 180;
  const tx = Math.cos(a) * throwPx;
  const ty = Math.sin(a) * throwPx;
  roomLight.setLook(resolveRoomLook(look));
  surface.setStrength(strength);
  // toSun is the opposite of the throw; the room looks out west, so a sun off due west only partly faces it.
  roomLight.setFrame({
    throwX: tx,
    throwY: ty,
    throwLenPx: throwPx,
    toSunX: -Math.cos(a),
    toSunY: -Math.sin(a),
    lowSun01: 0,
  });
  surface.setGlass?.({
    warpPx: 14,
    dispersion: 0.6,
    scale: 90,
    detail: 0.45,
    striation: 0.35,
    striationAngleDeg: 0,
    causticStrength: 0.8,
    causticSharpness: 2,
    seedOffset: [0, 0],
  });
  renderer.setRenderTarget(target);
  renderer.setClearColor(new THREE.Color(0, 0, 0), 1);
  renderer.clear();
  const t0 = performance.now();
  await renderer.renderAsync(scene, camera);
  renderer.setRenderTarget(null);
  const bytes = await renderer.readRenderTargetPixelsAsync(target, 0, 0, W, H);
  const ms = performance.now() - t0;

  let energy = 0;
  for (let i = 0; i < bytes.length; i += 4) energy += bytes[i] + bytes[i + 1] + bytes[i + 2];
  // The smeared pane: past the painted window, above the transom, clear of its edge.
  const pane = grain(bytes, 290, 380, 140, 236);
  const panePainted = grain(bytes, 120, 240, 140, 236);
  const out = {
    angleDeg,
    throwPx,
    glass,
    energy: energy / (255 * 3),
    grainSmear: +pane.grain.toFixed(4),
    meanSmear: +pane.mean.toFixed(4),
    grainPainted: +panePainted.grain.toFixed(4),
    meanPainted: +panePainted.mean.toFixed(4),
    transom: angleDeg === 0 ? transomEdge(bytes, 330) : null,
    firstRenderMs: Math.round(ms),
  };

  if (runId && file) {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(W, H);
    for (let i = 0; i < bytes.length; i += 4) {
      // As rendered (the lab runs the window at strength 6 so the far end is well above 8-bit rounding).
      img.data[i] = Math.min(255, bytes[i]);
      img.data[i + 1] = Math.min(255, bytes[i + 1]);
      img.data[i + 2] = Math.min(255, bytes[i + 2]);
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    out.png = await saveCanvasPng(runId, file, c);
  }
  return out;
}

window.smearLab = { run };
document.getElementById('status').textContent = 'window smear lab ready';
