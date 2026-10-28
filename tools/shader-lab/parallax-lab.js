/**
 * PARALLAX LAB — the floor-depth effect with the REAL code (2026-10-28, built for the Parallax card).
 *
 * A Foundry-shaped canvas (100 px grid, 25% padding) holding a three-floor stack: a ground floor that
 * fills the scene, a first floor and a second floor that are smaller building footprints, and a tree
 * canopy layer that stands 25 ft above the ground. Every layer is a mesh whose vertices are baked in world
 * px under an identity transform — exactly how the viewer builds its drawables — and is placed each frame by
 * the REAL `createParallaxSubsystem`. The REAL Table surface sits round it, dug to the heights the stack
 * publishes (`topHeight`, `bottomDepth`), exactly as the viewer feeds it.
 *
 * The 100 px grid is a layer the subsystem never touches: it is the proof that the viewed floor does not drift.
 *
 * Driving it: `window.parallaxLab` — `setFloor(n)` (glides), `snapFloor(n)`, `setView({cx, cy, halfSpan})`,
 * `setParams({...})`, `setTable(bool)`, `capture(name)` (PNG under `tools/shader-lab/runs/parallax-lab/`),
 * `state`, `info()`.
 *
 * @module tools/shader-lab/parallax-lab
 */

import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { TABLE_PARAMS } from '../../src/effects/table/table.js';
import { tableTopHeightPx } from '../../src/effects/table/table-model.js';
import { createTableSubsystem } from '../../src/effects/table/table-subsystem.js';
import { PARALLAX_PARAMS } from '../../src/effects/parallax/parallax.js';
import { createParallaxSubsystem } from '../../src/effects/parallax/parallax-subsystem.js';
import { markCompileDeferrable } from '../../src/core/compile-policy.js';
import { cloudTopsEyeMagnification } from '../../src/effects/clouds/cloud-shade.js';

const TSL = THREE.TSL;
const { texture } = TSL;

const W = 1280;
const H = 720;
const TREE_FT = 25;

const statusEl = document.getElementById('status');
const say = (msg) => {
  console.log('[parallax-lab]', msg);
  statusEl.textContent = msg;
};

// ── the painted stand-ins ────────────────────────────────────────────────────
function paint(w, h, fn) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const g = cv.getContext('2d');
  fn(g, w, h);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = false;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

const rnd = (() => {
  let s = 1234567;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
})();

/** @returns {{ tex: THREE.Texture, rect: {x:number,y:number,w:number,h:number} }[]} */
function makeLayers(sceneW, sceneH) {
  // Floor 0: grass and cobbles over the whole scene, with a path.
  const ground = paint(1024, 1024, (g, w, h) => {
    g.fillStyle = '#5d8a3f';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 2600; i++) {
      g.fillStyle = `rgba(${40 + rnd() * 50},${90 + rnd() * 70},${30 + rnd() * 40},0.35)`;
      g.fillRect(rnd() * w, rnd() * h, 3 + rnd() * 6, 3 + rnd() * 6);
    }
    g.strokeStyle = '#a89878';
    g.lineWidth = 46;
    g.beginPath();
    g.moveTo(0, h * 0.78);
    g.bezierCurveTo(w * 0.3, h * 0.6, w * 0.6, h * 0.95, w, h * 0.7);
    g.stroke();
    g.fillStyle = '#fff';
    g.font = 'bold 54px monospace';
    g.fillText('FLOOR 0', 40, 90);
  });
  // Floor 1: a building footprint, wood planks.
  const fp1 = { x: 800, y: 450, w: 1500, h: 1000 };
  const first = paint(1024, 1024, (g, w, h) => {
    g.fillStyle = '#9a6a3a';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(60,30,10,0.55)';
    g.lineWidth = 2;
    for (let y = 0; y < h; y += 22) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }
    g.strokeStyle = '#2a1608';
    g.lineWidth = 18;
    g.strokeRect(9, 9, w - 18, h - 18);
    g.fillStyle = '#fff';
    g.font = 'bold 54px monospace';
    g.fillText('FLOOR 1', 40, 90);
  });
  // Floor 2: a smaller footprint, slate.
  const fp2 = { x: 1150, y: 700, w: 900, h: 600 };
  const second = paint(1024, 1024, (g, w, h) => {
    g.fillStyle = '#5a6f8f';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(20,30,50,0.6)';
    g.lineWidth = 3;
    for (let y = 0; y < h; y += 64) for (let x = 0; x < w; x += 64) g.strokeRect(x, y, 64, 64);
    g.strokeStyle = '#161c2a';
    g.lineWidth = 18;
    g.strokeRect(9, 9, w - 18, h - 18);
    g.fillStyle = '#fff';
    g.font = 'bold 54px monospace';
    g.fillText('FLOOR 2', 40, 90);
  });
  // Trees: canopies on a transparent sheet over the whole scene.
  const trees = paint(1024, 1024, (g) => {
    const spots = [
      [140, 160, 90],
      [330, 700, 110],
      [820, 150, 100],
      [900, 820, 120],
      [120, 540, 70],
      [610, 900, 80],
      // A belt of trees cut off by the map's right edge, like a real map's border woods.
      [1010, 420, 90],
      [1000, 560, 80],
    ];
    for (const [x, y, r] of spots) {
      for (let k = 0; k < 7; k++) {
        const a = rnd() * Math.PI * 2;
        const d = rnd() * r * 0.45;
        g.fillStyle = `rgb(${30 + rnd() * 25},${90 + rnd() * 60},${30 + rnd() * 25})`;
        g.beginPath();
        g.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, r * (0.55 + rnd() * 0.35), 0, 7);
        g.fill();
      }
      g.strokeStyle = 'rgba(10,40,10,0.8)';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(x, y, r * 0.95, 0, 7);
      g.stroke();
    }
  });
  return {
    ground: { tex: ground, rect: { x: 0, y: 0, w: sceneW, h: sceneH } },
    first: { tex: first, rect: fp1 },
    second: { tex: second, rect: fp2 },
    trees: { tex: trees, rect: { x: 0, y: 0, w: sceneW, h: sceneH } },
  };
}

/** The 100 px grid, as a transparent sheet: the layer that must never move. */
function makeGrid(sceneW, sceneH, grid) {
  return paint(2048, 2048, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.strokeStyle = 'rgba(255,255,255,0.28)';
    g.lineWidth = 1;
    const cols = Math.round(sceneW / grid);
    const rows = Math.round(sceneH / grid);
    for (let i = 0; i <= cols; i++) {
      const x = Math.round((i / cols) * (w - 1)) + 0.5;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, h);
      g.stroke();
    }
    for (let j = 0; j <= rows; j++) {
      const y = Math.round((j / rows) * (h - 1)) + 0.5;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }
  });
}

/** A drawable the way the viewer builds one: vertices in WORLD px, identity mesh transform. */
function worldQuad(rect, material, order) {
  const { x, y, w, h } = rect;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([x, y, 0, x + w, y, 0, x + w, y + h, 0, x, y + h, 0]), 3)
  );
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const mesh = new THREE.Mesh(geo, material);
  mesh.renderOrder = order;
  mesh.frustumCulled = false;
  return mesh;
}

async function main() {
  const canvas = document.getElementById('view');
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  await renderer.init();
  renderer.setSize(W, H, false);

  const grid = 100;
  const sceneW = 3000;
  const sceneH = 2000;
  const padX = Math.ceil((sceneW * 0.25) / grid) * grid;
  const padY = Math.ceil((sceneH * 0.25) / grid) * grid;
  const rect = { minX: padX, minY: padY, maxX: padX + sceneW, maxY: padY + sceneH };
  const worldW = sceneW + 2 * padX;
  const worldH = sceneH + 2 * padY;

  // Foundry's levels: three floors, 10 ft each.
  const floors = [
    { index: 0, elevationBottom: 0, elevationTop: 10 },
    { index: 1, elevationBottom: 10, elevationTop: 20 },
    { index: 2, elevationBottom: 20, elevationTop: 30 },
  ];
  const allFloors = floors.slice();

  const layers = makeLayers(sceneW, sceneH);
  const gridTex = makeGrid(sceneW, sceneH, grid);

  // The REAL Table subsystem (floor, overlay and the board-shadow steps), as the viewer runs it.
  const uViewRect = TSL.uniform(TSL.vec4(0, 0, 1, 1));
  const table = createTableSubsystem({ THREE, markCompileDeferrable, uViewRect });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x151515);
  const camera = new THREE.OrthographicCamera(0, 1, 0, 1, -10, 10);

  const artMat = (tex, alpha = false) => {
    const m = new THREE.MeshBasicNodeMaterial();
    const s = texture(tex);
    m.colorNode = s.rgb;
    if (alpha) {
      m.opacityNode = s.a;
      m.transparent = true;
    }
    m.side = THREE.DoubleSide;
    m.depthTest = false;
    m.depthWrite = false;
    return m;
  };
  const off = (r) => ({ x: padX + r.x, y: padY + r.y, w: r.w, h: r.h });

  table.attach(scene);

  /** index → { mesh, elevation(kind) } */
  const drawables = [
    { name: 'floor0', mesh: worldQuad(off(layers.ground.rect), artMat(layers.ground.tex), 0), floor: 0, kind: 'floor' },
    { name: 'floor1', mesh: worldQuad(off(layers.first.rect), artMat(layers.first.tex), 1), floor: 1, kind: 'floor' },
    { name: 'floor2', mesh: worldQuad(off(layers.second.rect), artMat(layers.second.tex), 2), floor: 2, kind: 'floor' },
    {
      name: 'trees',
      mesh: worldQuad(off(layers.trees.rect), artMat(layers.trees.tex, true), 3),
      floor: 0,
      kind: 'canopy',
    },
  ];
  for (const d of drawables) scene.add(d.mesh);
  const gridMesh = worldQuad({ x: padX, y: padY, w: sceneW, h: sceneH }, artMat(gridTex, true), 1e5);
  // A stand-in cloud deck over the map (the real tops are a field shader; this checks only WHERE the deck hangs):
  // its own footprint is the scene rect at `state.cloudAltitudePx`, magnified by the shared eye exactly as the
  // viewer's `cloudTopsEyeMagnification` does — so it should hang over the rim, above the table top.
  const deckTex = paint(1024, 1024, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    for (let i = 0; i < 70; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      const r = 40 + rnd() * 120;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(255,255,255,0.55)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, r, 0, 7);
      g.fill();
    }
  });
  {
    const g = deckTex.image.getContext('2d');
    const w = deckTex.image.width;
    const band = w * 0.08;
    g.globalCompositeOperation = 'destination-in';
    for (const [x0, y0, x1, y1] of [
      [0, 0, band, 0],
      [w, 0, w - band, 0],
      [0, 0, 0, band],
      [0, w, 0, w - band],
    ]) {
      const grad = g.createLinearGradient(x0, y0, x1, y1);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(0,0,0,1)');
      g.fillStyle = grad;
      g.fillRect(0, 0, w, w);
    }
    g.globalCompositeOperation = 'source-over';
    deckTex.needsUpdate = true;
  }
  const deckMesh = worldQuad({ x: padX, y: padY, w: sceneW, h: sceneH }, artMat(deckTex, true), 2e6);
  deckMesh.visible = false;
  scene.add(deckMesh);
  scene.add(gridMesh);

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

  const tableParams = {};
  for (const [k, p] of Object.entries(TABLE_PARAMS)) tableParams[k] = p.default;
  const params = {};
  for (const [k, p] of Object.entries(PARALLAX_PARAMS)) params[k] = p.default;

  const subsystem = createParallaxSubsystem();
  const state = {
    cx: worldW / 2,
    cy: worldH / 2,
    halfSpan: 700,
    floor: 0,
    enabled: true,
    table: true,
    showGrid: true,
    clouds: false,
    cloudAltitudePx: 1400,
    /** Floors at or below the viewed floor are drawn (as if the author listed them as visible). */
    visibleBelow: true,
    t0: performance.now(),
  };

  const frame = () => {
    const now = performance.now() - state.t0;
    const aspect = W / H;
    const hx = state.halfSpan * aspect;
    const viewRect = {
      minX: state.cx - hx,
      maxX: state.cx + hx,
      minY: state.cy - state.halfSpan,
      maxY: state.cy + state.halfSpan,
    };
    Object.assign(camera, { left: viewRect.minX, right: viewRect.maxX, top: viewRect.minY, bottom: viewRect.maxY });
    camera.updateProjectionMatrix();

    const fr = subsystem.update({
      enabled: state.enabled,
      params,
      floors,
      floorIndex: state.floor,
      nowMs: now,
      viewRect,
      sceneRect: { width: sceneW, height: sceneH },
      fovDeg: tableParams.fovDeg,
      extraTopAbove: TREE_FT,
      tableTopPx:
        state.table && params.tableFollows
          ? tableTopHeightPx(tableParams, Math.min(sceneW, sceneH), state.halfSpan)
          : undefined,
      snap: state.snap === true,
    });
    state.snap = false;

    for (const d of drawables) {
      const base = fr ? fr.floorBase(d.floor) : 0;
      d.mesh.visible =
        d.kind === 'canopy' ? true : state.visibleBelow ? d.floor <= state.floor : d.floor === state.floor;
      if (d.kind === 'canopy') subsystem.placeItem(d.mesh, base + (fr ? TREE_FT : 0));
      else subsystem.placeItem(d.mesh, fr ? fr.floorBase(d.floor) : 0);
    }
    gridMesh.visible = state.showGrid;
    deckMesh.visible = state.clouds;
    if (state.clouds && fr) subsystem.placeScale(deckMesh, cloudTopsEyeMagnification(state.cloudAltitudePx, fr.eyeH));

    uViewRect.value.set(viewRect.minX, viewRect.minY, viewRect.maxX, viewRect.maxY);
    table.update({
      enabled: state.table,
      params: tableParams,
      viewRect,
      sceneRect: { x: padX, y: padY, width: sceneW, height: sceneH },
      canvasSize: { width: worldW, height: worldH },
      drawHeightPx: H,
      stack: fr && params.tableFollows ? { topHeightPx: fr.topHeight, floorDepthPx: fr.bottomDepth } : null,
      shade: fr ? subsystem.edgeShade() : null,
    });
    const tframe = table.info();
    return { fr, tframe };
  };

  let last = null;
  renderer.setAnimationLoop(() => {
    last = frame();
    drawTo(null);
  });

  // Pan / zoom like the viewer.
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

  async function capture(name = 'parallax') {
    frame();
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
    const r = await fetch(`/__lab/artifact?run=parallax-lab&file=${file}`, { method: 'POST', body: blob });
    return r.json();
  }

  // ── the panel ──────────────────────────────────────────────────────────────
  const floorsEl = document.getElementById('floors');
  for (let i = 0; i < floors.length; i++) {
    const b = document.createElement('button');
    b.textContent = `Floor ${i}`;
    b.onclick = () => (state.floor = i);
    floorsEl.append(b);
  }
  const panel = document.getElementById('panel');
  let lastCat = null;
  for (const [k, d] of Object.entries(PARALLAX_PARAMS)) {
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
    } else {
      input = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!params[k] });
      input.onchange = () => (params[k] = input.checked);
    }
    row.append(name, input, out);
    panel.append(row);
  }

  window.parallaxLab = {
    state,
    params,
    tableParams,
    setFloor: (n) => (state.floor = n),
    snapFloor: (n) => {
      state.floor = n;
      state.snap = true;
    },
    setView: (v) =>
      Object.assign(state, { cx: v.cx ?? state.cx, cy: v.cy ?? state.cy, halfSpan: v.halfSpan ?? state.halfSpan }),
    setParams: (p) => Object.assign(params, p),
    setTable: (on) => (state.table = !!on),
    setTableParams: (p) => Object.assign(tableParams, p),
    /** One floor only (a plain outdoor map, where the treetops are the stack's top) or all three. */
    setSingleFloor: (on) => {
      floors.length = 0;
      floors.push(...(on ? allFloors.slice(0, 1) : allFloors));
      state.floor = 0;
    },
    setEnabled: (on) => (state.enabled = !!on),
    setGrid: (on) => (state.showGrid = !!on),
    setClouds: (on, altitudePx = state.cloudAltitudePx) =>
      Object.assign(state, { clouds: !!on, cloudAltitudePx: altitudePx }),
    setVisibleBelow: (on) => (state.visibleBelow = !!on),
    capture,
    info: () => ({
      ...subsystem.info(),
      floor: state.floor,
      table: last?.tframe?.on
        ? {
            top: last.tframe.depthPx,
            floorDepth: last.tframe.floorDepthPx,
            shadeSteps: last.tframe.shadeSteps,
            shadeLast: last.tframe.shadeLast,
          }
        : null,
    }),
    world: { sceneW, sceneH, padX, padY, worldW, worldH },
  };
  say('ready — window.parallaxLab');
}

main().catch((err) => {
  console.error(err);
  say('FAILED: ' + (err && err.stack ? err.stack : err));
});
