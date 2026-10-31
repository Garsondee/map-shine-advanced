/**
 * SHADER LAB — THE LEAF SHED LAB. The REAL `createLeafShedEngine` over the author's REAL canopy art.
 *
 * The lab supplies only what the viewer would: a wind handle, the canopies (built by the real
 * `buildCanopyEmitters` from a small RGBA decode of the art, as the viewer's worker grid is), and a
 * clock. The art crops live in `tools/shader-lab/dev/leaf/` (git-ignored): `ground.png`, `tree.png`,
 * `bush.png`, cut from the Wilderness pack's deep-forest map (2400 px square, a 150 px grid).
 *
 *   await leafLab.ready
 *   leafLab.configure({ wind: { mps: 24, directionDeg: 270 } })
 *   await leafLab.advance(4)
 *   await leafLab.shot('gale')            // PNG under tools/shader-lab/runs/<run>/
 *
 * ⚠️ DRAW ORDER STANDS IN FOR THE DEPTH GATE. The viewer draws leaves after lighting and hides them
 * under canopies with the depth authority (`occlusionGate`); here there is no depth buffer, so the
 * stage is painted ground → leaves → bushes → trees, which shows the same thing for leaves at ground
 * level and under one canopy. Unlit (no illumination buffer), like the other engine labs.
 *
 * @module tools/shader-lab/leaf-shed-lab
 */
import * as THREE from '../../src/vendor/three/three.webgpu.js';
import * as W from '../../src/world/index.js';
import { createLeafShedEngine } from '../../src/effects/particles/leaf-shed-runtime.js';
import { LEAF_SHED_PARAMS, resolveLeafShedParams } from '../../src/effects/leaf-shed.js';
import { buildCanopyEmitters } from '../../src/effects/leaf-shed-sources.js';
import { createLeafShedSubsystem } from '../../src/effects/leaf-shed-subsystem.js';
import { saveCanvasPng, makeRunId } from './contract.js';

const TSL = THREE.TSL;
const q = new URLSearchParams(location.search);
const STAGE_W = Number(q.get('w') ?? 960);
const STAGE_H = Number(q.get('h') ?? 720);
const SPAN = 2400;
const GRID_PX = 150;
const PX_PER_M = GRID_PX / 1.524;
const statusEl = document.getElementById('status');
const say = (m) => {
  if (statusEl) statusEl.textContent = m;
};

const HALF_LUT = new Float32Array(65536);
for (let h = 0; h < 65536; h++) {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  const v = e === 0 ? f * 2 ** -24 : e === 0x1f ? (f ? NaN : Infinity) : (f / 1024 + 1) * 2 ** (e - 15);
  HALF_LUT[h] = s ? -v : v;
}
const oetfByte = (c) => {
  const v = Math.max(0, Math.min(1, c));
  return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255);
};

/** A seeded RNG, so a shot is the same shot twice. */
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function loadBitmap(url) {
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(`leaf lab: ${url} -> HTTP ${res.status} (cut the art crops into tools/shader-lab/dev/leaf/)`);
  return createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
}

/** The viewer's worker grid, reproduced: a resized decode of the canopy file, RGBA bytes. */
async function canopyRaster(url, maxDim = 512) {
  const res = await fetch(url);
  const blob = await res.blob();
  const probe = await createImageBitmap(blob);
  const s = Math.min(1, maxDim / Math.max(probe.width, probe.height));
  const w = Math.round(probe.width * s);
  const h = Math.round(probe.height * s);
  probe.close();
  const small = await createImageBitmap(blob, {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
    resizeWidth: w,
    resizeHeight: h,
    resizeQuality: 'high',
  });
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(small, 0, 0);
  small.close();
  const img = ctx.getImageData(0, 0, w, h);
  return { spec: { x: 0, y: 0, w, h, texelW: SPAN / w, texelH: SPAN / h }, rgba: img.data };
}

const BASE = {
  zoom: 0.5,
  centre: [1200, 1200],
  wind: { mps: 24, directionDeg: 270, gust01: 0.5 },
  params: {},
  seed: 7,
  heightFt: { tree: 25, bush: 2 },
};

async function main() {
  const canvas = document.getElementById('view');
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  await renderer.init();
  renderer.setSize(STAGE_W, STAGE_H, false);
  const stage = new THREE.RenderTarget(STAGE_W, STAGE_H, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.NoColorSpace,
    depthBuffer: false,
  });

  // ── the art ──────────────────────────────────────────────────────────────
  function artMesh(bmp) {
    const tex = new THREE.Texture(bmp);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.flipY = false;
    tex.needsUpdate = true;
    const mat = new THREE.NodeMaterial();
    const c = TSL.texture(tex).sample(TSL.uv());
    mat.colorNode = TSL.vec4(c.rgb, c.a);
    mat.transparent = true;
    mat.depthTest = false;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;
    mat.toneMapped = false;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    mesh.frustumCulled = false;
    mesh.position.set(SPAN / 2, SPAN / 2, 0);
    mesh.scale.set(SPAN, SPAN, 1);
    const sc = new THREE.Scene();
    sc.add(mesh);
    return sc;
  }
  const [groundBmp, treeBmp, bushBmp] = await Promise.all([
    loadBitmap('/tools/shader-lab/dev/leaf/ground.png'),
    loadBitmap('/tools/shader-lab/dev/leaf/tree.png'),
    loadBitmap('/tools/shader-lab/dev/leaf/bush.png'),
  ]);
  const groundScene = artMesh(groundBmp);
  const treeScene = artMesh(treeBmp);
  const bushScene = artMesh(bushBmp);
  const [treeRaster, bushRaster] = await Promise.all([
    canopyRaster('/tools/shader-lab/dev/leaf/tree.png'),
    canopyRaster('/tools/shader-lab/dev/leaf/bush.png'),
  ]);
  const emitters = [...buildCanopyEmitters(treeRaster, 'tree'), ...buildCanopyEmitters(bushRaster, 'bush')];

  // ── the wind ─────────────────────────────────────────────────────────────
  const uSpeed = TSL.uniform(TSL.float(0));
  const uDir = TSL.uniform(TSL.float(270));
  const uGust = TSL.uniform(TSL.float(0.5));
  const uPpm = TSL.uniform(TSL.float(PX_PER_M));
  const windHandle = W.createWindHandle({
    ambientWind: { directionDeg: uDir, speed01: uSpeed, gustiness01: uGust, pixelsPerMetre: uPpm },
  });

  let S = JSON.parse(JSON.stringify(BASE));
  let engine = null;
  let sub = null;
  let rng = mulberry32(S.seed);
  let nowMs = 1000;
  const SCENE_RECT = { minX: 0, minY: 0, maxX: SPAN, maxY: SPAN };
  const SQUARE = [
    { x: 0, y: 0 },
    { x: SPAN, y: 0 },
    { x: SPAN, y: SPAN },
    { x: 0, y: SPAN },
  ];
  const RASTERS = new Map([
    ['/tools/shader-lab/dev/leaf/tree.png', treeRaster],
    ['/tools/shader-lab/dev/leaf/bush.png', bushRaster],
  ]);

  // ── a stand-in `_Outdoors` mask: white outdoors, black indoors (two painted rooms the wind blows at) ──────
  const OUT_N = 150;
  const outData = new Uint8Array(OUT_N * OUT_N * 4);
  const outTex = new THREE.DataTexture(outData, OUT_N, OUT_N, THREE.RGBAFormat, THREE.UnsignedByteType);
  outTex.minFilter = THREE.LinearFilter;
  outTex.magFilter = THREE.LinearFilter;
  outTex.wrapS = THREE.ClampToEdgeWrapping;
  outTex.wrapT = THREE.ClampToEdgeWrapping;
  const ROOMS = [
    [800, 700, 1400, 1250],
    [1400, 1000, 1700, 1250],
  ];
  function paintOutdoors(withRooms) {
    for (let y = 0; y < OUT_N; y++)
      for (let x = 0; x < OUT_N; x++) {
        const wx = ((x + 0.5) / OUT_N) * SPAN;
        const wy = ((y + 0.5) / OUT_N) * SPAN;
        const inside = withRooms && ROOMS.some(([x0, y0, x1, y1]) => wx >= x0 && wx < x1 && wy >= y0 && wy < y1);
        const v = inside ? 0 : 255;
        const o = (y * OUT_N + x) * 4;
        outData[o] = outData[o + 1] = outData[o + 2] = v;
        outData[o + 3] = 255;
      }
    outTex.needsUpdate = true;
  }
  paintOutdoors(true);
  const outdoorsTexNode = TSL.texture(outTex);
  const uOutdoorsRect = TSL.uniform(new THREE.Vector4(0, 0, SPAN, SPAN));
  // The rooms, tinted so a shot shows where the black is (the viewer has the lighting to do that).
  const roomsScene = (() => {
    const mat = new THREE.NodeMaterial();
    const m = outdoorsTexNode.sample(TSL.uv()).r;
    mat.colorNode = TSL.vec4(0.55, 0.1, 0.35, TSL.float(1).sub(m).mul(0.32));
    mat.transparent = true;
    mat.depthTest = false;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;
    mat.toneMapped = false;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    mesh.frustumCulled = false;
    mesh.position.set(SPAN / 2, SPAN / 2, 0);
    mesh.scale.set(SPAN, SPAN, 1);
    const sc = new THREE.Scene();
    sc.add(mesh);
    return sc;
  })();

  // THE REAL SUBSYSTEM, fed what the viewer would feed it: two canopy files covering the stage, the
  // colour grid (here the lab's own resized decode — the worker's twin), the wind, a clock.
  function makeSubsystem() {
    engine = null;
    sub = createLeafShedSubsystem({
      THREE,
      createEngine: (a) => (engine = createLeafShedEngine({ ...a, capacity: 2048 })),
      engineDeps: { outdoorsTexNode, uOutdoorsRect },
      getRenderState: () => ({
        enabled: true,
        params: S.params,
        profile: 'standard',
        gridPx: GRID_PX,
        pxPerFt: GRID_PX / 5,
        treeHeightFt: S.heightFt.tree,
        bushHeightFt: S.heightFt.bush,
        groundElevation: 0,
      }),
      listCanopies: () => [
        {
          key: 'tree',
          url: '/tools/shader-lab/dev/leaf/tree.png',
          kind: 'tree',
          corners: SQUARE,
          visible: S.show?.tree !== false,
        },
        {
          key: 'bush',
          url: '/tools/shader-lab/dev/leaf/bush.png',
          kind: 'bush',
          corners: SQUARE,
          visible: S.show?.bush !== false,
        },
      ],
      requestColourGrid: async (url) => {
        const r = RASTERS.get(url);
        return r ? { gridW: r.spec.w, gridH: r.spec.h, rgba: r.rgba } : null;
      },
      getWindHandle: () => windHandle,
      getWindSpeed01: () => uSpeed.value,
      random: () => rng(),
    });
  }
  function params() {
    return resolveLeafShedParams(S.params);
  }
  function applyLook() {}
  const camera = new THREE.OrthographicCamera(0, 1, 0, 1, -10, 10);
  const viewRect = () => {
    const w = STAGE_W / S.zoom;
    const h = STAGE_H / S.zoom;
    return {
      minX: S.centre[0] - w / 2,
      maxX: S.centre[0] + w / 2,
      minY: S.centre[1] - h / 2,
      maxY: S.centre[1] + h / 2,
    };
  };

  function step(dt) {
    nowMs += dt * 1000;
    uSpeed.value = W.speed01ForMetresPerSecond(S.wind.mps);
    uDir.value = S.wind.directionDeg;
    uGust.value = S.wind.gust01;
    sub.sync(renderer, {
      dtSec: dt,
      tMs: nowMs,
      viewRect: viewRect(),
      sceneRect: SCENE_RECT,
      shadowThrow: S.shadowThrow ?? { x: 0.25, y: 0.38 },
      daylight01: S.daylight01 ?? 1,
    });
  }
  /** Let the colour requests (promises) land before the clock runs. */
  async function warm() {
    step(0);
    await new Promise((r) => setTimeout(r, 0));
  }

  function drawStage() {
    const rect = viewRect();
    camera.left = rect.minX;
    camera.right = rect.maxX;
    camera.top = rect.minY;
    camera.bottom = rect.maxY;
    camera.updateProjectionMatrix();
    renderer.setRenderTarget(stage);
    renderer.setClearColor(new THREE.Color(0, 0, 0), 1);
    renderer.autoClear = true;
    renderer.clear();
    renderer.autoClear = false;
    renderer.render(groundScene, camera);
    if (sub.hasContent && sub.scene) renderer.render(sub.scene, camera);
    if (S.show?.bush !== false) renderer.render(bushScene, camera);
    if (S.show?.tree !== false) renderer.render(treeScene, camera);
    if (S.indoors !== false) renderer.render(roomsScene, camera);
    renderer.autoClear = true;
    renderer.setRenderTarget(null);
  }

  async function stageCanvas() {
    const raw = await renderer.readRenderTargetPixelsAsync(stage, 0, 0, STAGE_W, STAGE_H);
    const data = raw instanceof Promise ? await raw : raw;
    const isHalf = data instanceof Uint16Array;
    const c = document.createElement('canvas');
    c.width = STAGE_W;
    c.height = STAGE_H;
    const img = new ImageData(STAGE_W, STAGE_H);
    for (let i = 0; i < STAGE_W * STAGE_H; i++) {
      for (let ch = 0; ch < 3; ch++)
        img.data[i * 4 + ch] = oetfByte(isHalf ? HALF_LUT[data[i * 4 + ch]] : data[i * 4 + ch]);
      img.data[i * 4 + 3] = 255;
    }
    c.getContext('2d').putImageData(img, 0, 0);
    return c;
  }
  const show = document.getElementById('show');
  const present = (c) => show?.getContext('2d')?.drawImage(c, 0, 0, show.width, show.height);

  const runId = makeRunId('leaf-shed');
  makeSubsystem();
  await warm();
  const lab = {
    runId,
    emitters,
    get state() {
      return S;
    },
    /** Read the engine's live GPU state (lab only): per-slot rows of the arena buffers. */
    async inspect(n = 64) {
      if (!engine) return { kept: 0, alive: 0, rows: [] };
      const b = engine.labBuffers;
      const read = async (node) => new Float32Array(await renderer.getArrayBufferAsync(node.value));
      const [pos, vel, age, life, cus] = await Promise.all([b.position, b.velocity, b.age, b.life, b.custom].map(read));
      const rows = [];
      for (let i = 0; i < Math.min(n, engine.capacity); i++) {
        rows.push({
          i,
          x: +pos[i * 2].toFixed(0),
          y: +pos[i * 2 + 1].toFixed(0),
          vx: +vel[i * 2].toFixed(0),
          vy: +vel[i * 2 + 1].toFixed(0),
          age: +age[i].toFixed(2),
          life: +life[i].toFixed(2),
          h: +cus[i * 4].toFixed(0),
          kept: cus[i * 4 + 3],
        });
      }
      let kept = 0;
      let alive = 0;
      for (let i = 0; i < engine.capacity; i++) {
        if (cus[i * 4 + 3] > 0.5) kept++;
        if ((life[i] < 0 || age[i] < life[i]) && cus[i * 4 + 3] > 0.5) alive++;
      }
      return { kept, alive, rows };
    },
    defaults: Object.fromEntries(Object.entries(LEAF_SHED_PARAMS).map(([k, d]) => [k, d.default])),
    /** Reset everything (a fresh engine, a fresh seeded RNG). */
    async configure(cfg = {}) {
      S = { ...JSON.parse(JSON.stringify(BASE)), ...cfg, wind: { ...BASE.wind, ...(cfg.wind ?? {}) } };
      rng = mulberry32(S.seed);
      nowMs = 1000;
      paintOutdoors(S.indoors !== false);
      makeSubsystem();
      await warm();
      return S;
    },
    /** Change wind/params/view without resetting the leaves in flight. */
    patch(cfg = {}) {
      if (cfg.wind) S.wind = { ...S.wind, ...cfg.wind };
      if (cfg.params) S.params = { ...S.params, ...cfg.params };
      for (const k of ['zoom', 'centre', 'show', 'heightFt', 'shadowThrow', 'daylight01', 'indoors'])
        if (cfg[k] !== undefined) S[k] = cfg[k];
      if (cfg.indoors !== undefined) paintOutdoors(cfg.indoors !== false);
      applyLook();
      return S;
    },
    /**
     * A SHAPE SHEET: leaves / clumps / twigs lying still at the real art scale, nothing else drawn — for judging
     * the outline and the form up close (`zoom` 4 ≈ 3× the screen size). `flying` = off the ground, mid-turn.
     */
    async sheet({ rgb = [0.35, 0.6, 0.22], twigRgb = [158 / 255, 112 / 255, 92 / 255], zoom = 4, perRow = 10, flying = false, kinds = [0, 1, 2] } = {}) {
      lab.patch({ params: { amount: 0 }, show: { tree: false, bush: false }, indoors: false, zoom, centre: [1200, 1200] });
      const SIZE = [GRID_PX * 0.22, GRID_PX * 0.22 * 1.45, GRID_PX * 0.22 * 2.1];
      const list = [];
      const span = STAGE_W / zoom;
      for (let row = 0; row < kinds.length; row++)
        for (let k = 0; k < perRow; k++)
          list.push({
            x: 1200 - span / 2 + ((k + 0.5) / perRow) * span,
            y: 1200 - STAGE_H / zoom / 2 + ((row + 0.5) / kinds.length) * (STAGE_H / zoom),
            kind: kinds[row],
            ramp: 1,
            sizePx: SIZE[kinds[row]],
            rgb: (kinds[row] === 2 ? twigRgb : rgb.map((c, i) => c * (0.85 + 0.3 * (((k * 7 + i * 3) % 5) / 4)))).map((c) => c * 255),
            heightPx: flying ? 6 : 0,
          });
      engine.writeBirths(list);
      lab.patch({ wind: { mps: 40 } });
      step(0);
      step(0);
      // The kept/refused roll is made at birth, in a gale; then the air stops and the fade-in finishes.
      lab.patch({ wind: { mps: 0 } });
      await lab.advance(0.4);
      return { births: list.length };
    },
    /**
     * MOTION METRICS: release `n` bodies of one kind high over open ground, follow them, and measure how they
     * move — flight time, how far each flies, how crooked the path is (path length / net distance), how many
     * px it moves AFTER landing, and the speed it lands at. Numbers, not a screenshot (the way to judge friction
     * and turbulence). Never reads in-frame: lab-only buffer reads, the way `inspect` does.
     */
    async trace({ kind = 0, n = 12, heightPx = 220, sec = 10, wind = null, from = [700, 500], indoors = false } = {}) {
      lab.patch({ params: { amount: 0 }, indoors, ...(wind ? { wind } : {}) });
      const SIZE = [GRID_PX * 0.22, GRID_PX * 0.22 * 1.45, GRID_PX * 0.22 * 2.1];
      const start = engine.debugState().nextSlot;
      const list = [];
      for (let k = 0; k < n; k++)
        list.push({ x: from[0] + (k % 4) * 90, y: from[1] + Math.floor(k / 4) * 90, kind, ramp: 1, sizePx: SIZE[kind], rgb: [90, 160, 60], heightPx });
      engine.writeBirths(list);
      const read = async (node) => new Float32Array(await renderer.getArrayBufferAsync(node.value));
      const b = engine.labBuffers;
      const tracks = Array.from({ length: n }, () => ({ pts: [], landed: null }));
      const steps = Math.round(sec * 30);
      for (let i = 0; i <= steps; i++) {
        step(1 / 30);
        if (i % 3 === 0) {
          const [pos, cus, vel] = await Promise.all([read(b.position), read(b.custom), read(b.velocity)]);
          for (let k = 0; k < n; k++) {
            const j = (start + k) % engine.capacity;
            if (cus[j * 4 + 3] < 0.5) continue;
            const t = tracks[k];
            const pt = { x: pos[j * 2], y: pos[j * 2 + 1], h: cus[j * 4], sp: Math.hypot(vel[j * 2], vel[j * 2 + 1]) };
            if (!t.landed && pt.h <= 0) t.landed = { ...pt, i: t.pts.length };
            t.pts.push(pt);
          }
        }
      }
      const rows = [];
      for (const t of tracks) {
        if (t.pts.length < 3) continue;
        const air = t.landed ? t.pts.slice(0, t.landed.i + 1) : t.pts;
        let path = 0;
        for (let i = 1; i < air.length; i++) path += Math.hypot(air[i].x - air[i - 1].x, air[i].y - air[i - 1].y);
        const net = Math.hypot(air[air.length - 1].x - air[0].x, air[air.length - 1].y - air[0].y);
        const end = t.pts[t.pts.length - 1];
        // Sideways wander: RMS distance of the flight from the straight line start → landing (px).
        const a0 = air[0];
        const a1 = air[air.length - 1];
        const L = Math.max(net, 1);
        let acc = 0;
        for (const q of air) acc += (((q.x - a0.x) * (a1.y - a0.y) - (q.y - a0.y) * (a1.x - a0.x)) / L) ** 2;
        const inRoom = t.pts.filter((q) => ROOMS.some(([x0, y0, x1, y1]) => q.x >= x0 && q.x < x1 && q.y >= y0 && q.y < y1)).length;
        rows.push({
          insideFrac: +(inRoom / t.pts.length).toFixed(3),
          wanderPx: +Math.sqrt(acc / air.length).toFixed(0),
          flightSec: t.landed ? +((t.landed.i * 3) / 30).toFixed(2) : null,
          flightPx: +net.toFixed(0),
          crooked: +(path / Math.max(net, 1)).toFixed(2),
          landSpeed: t.landed ? +t.landed.sp.toFixed(0) : null,
          groundSlidePx: t.landed ? +Math.hypot(end.x - t.landed.x, end.y - t.landed.y).toFixed(0) : null,
        });
      }
      const avg = (k) => {
        const v = rows.map((r) => r[k]).filter((x) => x != null);
        return v.length ? +(v.reduce((a, c) => a + c, 0) / v.length).toFixed(2) : null;
      };
      return {
        kind,
        tracked: rows.length,
        mean: { insideFrac: avg('insideFrac'), wanderPx: avg('wanderPx'), flightSec: avg('flightSec'), flightPx: avg('flightPx'), crooked: avg('crooked'), landSpeed: avg('landSpeed'), groundSlidePx: avg('groundSlidePx') },
        rows: rows.slice(0, 4),
        firstTrack: (tracks.find((t) => t.pts.length > 3)?.pts ?? []).filter((_, i) => i % 2 === 0).map((q) => [Math.round(q.x), Math.round(q.y), Math.round(q.h)]),
      };
    },
    async advance(sec, { dt = 1 / 30 } = {}) {
      const n = Math.max(1, Math.round(sec / dt));
      for (let i = 0; i < n; i++) step(dt);
      return { steps: n, nowSec: nowMs / 1000, status: sub.getStatus() };
    },
    async shot(name = 'shot') {
      step(1 / 30);
      drawStage();
      const c = await stageCanvas();
      present(c);
      return { file: await saveCanvasPng(runId, `${name}.png`, c), run: runId, status: sub.getStatus() };
    },
    /** Timeline contact sheet: each step `{label, set?, advance?}`; leaves persist between tiles. */
    async timeline(name, steps, { cols = 3, tilePx = 480 } = {}) {
      const rows = Math.ceil(steps.length / cols);
      const th = Math.round((tilePx * STAGE_H) / STAGE_W);
      const out = document.createElement('canvas');
      out.width = tilePx * cols;
      out.height = th * rows;
      const ctx = out.getContext('2d');
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i];
        if (st.set) lab.patch(st.set);
        if (st.advance) await lab.advance(st.advance);
        step(1 / 30);
        drawStage();
        const c = await stageCanvas();
        const ox = (i % cols) * tilePx;
        const oy = Math.floor(i / cols) * th;
        ctx.drawImage(c, ox, oy, tilePx, th);
        const label = String(st.label ?? i);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(ox + 4, oy + 4, 14 + label.length * 7.2, 20);
        ctx.fillStyle = '#fff';
        ctx.font = '12px monospace';
        ctx.fillText(label, ox + 10, oy + 18);
      }
      present(out);
      return { file: await saveCanvasPng(runId, `${name}.png`, out), run: runId };
    },
    status() {
      return { emitters: emitters.length, status: sub.getStatus(), params: params() };
    },
  };
  window.leafLab = lab;
  say(`ready — ${emitters.length} canopies (${emitters.filter((e) => e.kind === 'tree').length} tree blobs)`);
  return lab;
}

window.leafLab = { ready: main() };
window.leafLab.ready.then(
  (lab) => {
    lab.ready = Promise.resolve(lab);
  },
  (err) => say(`FAILED: ${err?.stack || err}`)
);
