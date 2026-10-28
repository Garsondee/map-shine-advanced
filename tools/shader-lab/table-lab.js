/**
 * TABLE LAB — the Table surface round a real map (2026-10-27, built for the
 * Table card).
 *
 * A Foundry-shaped canvas: a scene rect (the Mansion's ground floor, copied to
 * `runs/table-lab/map.webp`, or a painted stand-in) inside 25% padding. The
 * board is drawn exactly as the orthographic viewer would; the REAL
 * `buildTableNodes` lays the brass rim, velvet and recess over it, driven by
 * the REAL `resolveTableFrame`.
 *
 * Driving it: `window.tableLab` — `setView({cx, cy, halfSpan})`, `setParams({...})`,
 * `capture(name)` (PNG under `tools/shader-lab/runs/table-lab/`), `state`.
 *
 * @module tools/shader-lab/table-lab
 */

import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { TABLE_PARAMS } from '../../src/effects/table/table.js';
import { resolveTableFrame } from '../../src/effects/table/table-model.js';
import { createTableUniforms, applyTableFrame, buildTableMaterials } from '../../src/effects/table/table-render.js';
import { markCompileDeferrable } from '../../src/core/compile-policy.js';

const TSL = THREE.TSL;
const { texture } = TSL;

const W = 1280;
const H = 720;

const statusEl = document.getElementById('status');
const say = (msg) => {
  console.log('[table-lab]', msg);
  statusEl.textContent = msg;
};

async function loadMap() {
  try {
    const r = await fetch('/tools/shader-lab/runs/table-lab/map.webp');
    if (!r.ok) throw new Error(String(r.status));
    const blob = await r.blob();
    const full = await createImageBitmap(blob);
    // The Mansion is 12000² — over the GPU's texture limit. The world keeps
    // its real size; only the picture is shrunk.
    const s = Math.min(1, 4096 / Math.max(full.width, full.height));
    const bmp = await createImageBitmap(full, {
      resizeWidth: Math.round(full.width * s),
      resizeHeight: Math.round(full.height * s),
      resizeQuality: 'high',
    });
    const t = new THREE.Texture(bmp);
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return { tex: t, w: full.width, h: full.height };
  } catch (err) {
    console.warn('[table-lab] no map.webp, painting a stand-in', err);
    const cv = document.createElement('canvas');
    cv.width = 1024;
    cv.height = 1024;
    const g = cv.getContext('2d');
    g.fillStyle = '#6d8f45';
    g.fillRect(0, 0, 1024, 1024);
    g.fillStyle = '#3b2a1e';
    g.fillRect(300, 250, 420, 380);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false;
    return { tex: t, w: 1024, h: 1024 };
  }
}

async function main() {
  const canvas = document.getElementById('view');
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  await renderer.init();
  renderer.setSize(W, H, false);

  const map = await loadMap();
  // Foundry's geometry: 100 px grid, the map at its own size, 25% padding.
  const grid = 100;
  const sceneW = map.w;
  const sceneH = map.h;
  const padX = Math.ceil((sceneW * 0.25) / grid) * grid;
  const padY = Math.ceil((sceneH * 0.25) / grid) * grid;
  const rect = { minX: padX, minY: padY, maxX: padX + sceneW, maxY: padY + sceneH };
  const worldW = sceneW + 2 * padX;
  const worldH = sceneH + 2 * padY;

  const u = createTableUniforms(TSL);
  const { floor, overlay } = buildTableMaterials(THREE, u, markCompileDeferrable);

  // The viewer's arrangement: an orthographic, Y-down camera over the world; the
  // floor sorts below the board art, the overlay above everything.
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x999999); // Foundry's fallback scene background
  const camera = new THREE.OrthographicCamera(0, 1, 0, 1, -10, 10);
  const plane = new THREE.PlaneGeometry(1, 1);
  const boardMat = new THREE.MeshBasicNodeMaterial();
  boardMat.colorNode = texture(map.tex).rgb;
  boardMat.side = THREE.DoubleSide;
  boardMat.depthTest = false;
  boardMat.depthWrite = false;
  const mk = (material, order) => {
    const m = new THREE.Mesh(plane, material);
    m.renderOrder = order;
    m.frustumCulled = false;
    scene.add(m);
    return m;
  };
  const floorMesh = mk(floor, -1);
  const boardMesh = mk(boardMat, 0);
  boardMesh.position.set((rect.minX + rect.maxX) / 2, (rect.minY + rect.maxY) / 2, 0);
  boardMesh.scale.set(sceneW, sceneH, 1);
  const overlayMesh = mk(overlay, 1e6);

  // The world pass holds LINEAR colour (the lit/composite stages encode later); the lab's
  // present step does the sRGB encode the real chain does at the end.
  // TWO attachments, like the viewer's world pass (`output` + scene `attr`): a material that
  // only writes attachment 0 fails here exactly as it does in Foundry.
  const lit = new THREE.RenderTarget(W, H, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    count: 2,
  });
  lit.textures[0].name = 'output';
  lit.textures[1].name = 'attr';
  const worldMrt = TSL.mrt({ output: TSL.output, attr: TSL.vec4(0, 0, 0, 0) });
  const presentMat = new THREE.NodeMaterial();
  const litRgb = texture(lit.textures[0]).rgb.max(0);
  presentMat.fragmentNode = TSL.vec4(TSL.pow(litRgb, TSL.vec3(1 / 2.2, 1 / 2.2, 1 / 2.2)), 1);
  const present = new THREE.QuadMesh(presentMat);
  const ldr = new THREE.RenderTarget(W, H, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
  });
  const drawTo = (target) => {
    renderer.setRenderTarget(lit);
    renderer.setMRT(worldMrt);
    renderer.render(scene, camera);
    renderer.setMRT(null);
    renderer.setRenderTarget(target);
    present.render(renderer);
    renderer.setRenderTarget(null);
  };

  const params = {};
  for (const [k, p] of Object.entries(TABLE_PARAMS)) params[k] = p.default;
  const state = {
    cx: worldW / 2,
    cy: worldH / 2,
    halfSpan: worldH / 2,
    enabled: true,
  };

  const push = () => {
    const aspect = W / H;
    const hx = state.halfSpan * aspect;
    Object.assign(camera, {
      left: state.cx - hx,
      right: state.cx + hx,
      top: state.cy - state.halfSpan,
      bottom: state.cy + state.halfSpan,
    });
    camera.updateProjectionMatrix();
    for (const m of [floorMesh, overlayMesh]) {
      m.position.set(state.cx, state.cy, 0);
      m.scale.set(hx * 2.02, state.halfSpan * 2.02, 1);
      m.visible = state.enabled;
    }
    const frame = resolveTableFrame(params, {
      boardMinSidePx: Math.min(sceneW, sceneH),
      halfSpanPx: state.halfSpan,
      eye: { x: state.cx, y: state.cy },
    });
    applyTableFrame(u, frame, { rect, outer: { minX: 0, minY: 0, maxX: worldW, maxY: worldH }, padX, padY, worldPerPx: (2 * state.halfSpan) / H });
    return frame;
  };

  let frameInfo = null;
  const draw = () => {
    frameInfo = push();
    drawTo(null);
  };
  renderer.setAnimationLoop(draw);

  // Pan / zoom like the viewer: drag keeps the world point under the cursor.
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup', () => (drag = null));
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const scale = (2 * state.halfSpan) / canvas.clientHeight;
    state.cx -= (e.clientX - drag.x) * scale;
    state.cy -= (e.clientY - drag.y) * scale;
    drag = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      state.halfSpan = Math.max(150, Math.min(worldH * 1.6, state.halfSpan * Math.exp(e.deltaY * 0.001)));
    },
    { passive: false }
  );

  async function capture(name = 'table') {
    push();
    drawTo(ldr);
    const buf = await renderer.readRenderTargetPixelsAsync(ldr, 0, 0, W, H);
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(W, H);
    const src = buf instanceof Uint8Array || buf instanceof Uint8ClampedArray ? buf : Uint8ClampedArray.from(buf);
    if (src.length === W * H * 4) img.data.set(src);
    else {
      const stride = Math.ceil((W * 4) / 256) * 256;
      for (let y = 0; y < H; y++) img.data.set(src.subarray(y * stride, y * stride + W * 4), y * W * 4);
    }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
    const file = `${String(name).replace(/[^A-Za-z0-9._-]/g, '_')}.png`;
    const r = await fetch(`/__lab/artifact?run=table-lab&file=${file}`, { method: 'POST', body: blob });
    return r.json();
  }

  // ── the panel ──────────────────────────────────────────────────────────────
  const panel = document.getElementById('panel');
  let lastCat = null;
  for (const [k, d] of Object.entries(TABLE_PARAMS)) {
    if (d.category !== lastCat) {
      const h = document.createElement('h4');
      h.textContent = d.category;
      panel.append(h);
      lastCat = d.category;
    }
    const row = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = d.label;
    name.title = d.help;
    const out = document.createElement('span');
    let input;
    if (d.type === 'float') {
      input = Object.assign(document.createElement('input'), { type: 'range', min: d.min, max: d.max, step: d.step });
      input.value = params[k];
      out.textContent = String(params[k]);
      input.oninput = () => {
        params[k] = Number(input.value);
        out.textContent = input.value;
      };
    } else if (d.type === 'color') {
      input = Object.assign(document.createElement('input'), { type: 'color', value: params[k] });
      input.oninput = () => (params[k] = input.value);
    } else {
      input = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!params[k] });
      input.onchange = () => (params[k] = input.checked);
    }
    row.append(name, input, out);
    panel.append(row);
  }

  window.tableLab = {
    meshes: { floorMesh, boardMesh, overlayMesh },
    renderer,
    state,
    params,
    rect,
    world: { w: worldW, h: worldH },
    setView(v) {
      Object.assign(state, v);
      return { ...state };
    },
    setParams(p) {
      Object.assign(params, p);
      return { ...params };
    },
    capture,
    frame: () => frameInfo,
  };
  say(`ready — scene ${sceneW}×${sceneH} in a ${worldW}×${worldH} canvas (pad ${padX}×${padY})`);
}

main().catch((err) => say('FAILED: ' + (err?.stack ?? err)));
