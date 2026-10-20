/**
 * SHADER LAB — THE FIRE ENGINE LAB. The REAL `createFireSubsystem`, end to end, on a real GPU.
 *
 * What `fire-billow-lab.js` judges (the look of one fire, from above and the side) this proves WORKS AS A SYSTEM: the
 * billow engine's weather at each fire (wind bake, sky, rain), each fire's long life (rain puts it out, the coals
 * smoulder, the ash goes cold, a dry spell relights it), the painted spawn cloud, the real ember engine, and the
 * splat/contour pass, all through the same module the game builds. The lab supplies only what Foundry would: a fire
 * list, a spawn cloud, a wind handle (open ground, or a real baked room), a precipitation number and a clock.
 *
 *   await fireEngineLab.ready
 *   fireEngineLab.configure({ fires: [{ id: 'camp', x: 2048, y: 2300, diameterPx: 100, outdoors01: 1 }], wind: { speed01: 0.6 } })
 *   await fireEngineLab.advance(6)                       // seconds of fire clock, stepped at 1/30 s
 *   await fireEngineLab.shot('calm')                     // PNG under tools/shader-lab/runs/<run>/
 *   fireEngineLab.setRain(1); await fireEngineLab.advance(40); fireEngineLab.lives()
 *
 * ⚠️ No bloom and no scene lighting here (the smoke is lit by one flat ambient), exactly like the billow lab. Lab-green
 * is BUILT (unverified); only the author, on a real scene, says LIVE.
 *
 * @module tools/shader-lab/fire-engine-lab
 */
import * as THREE from '../../src/vendor/three/three.webgpu.js';
import * as W from '../../src/world/index.js';
import { createFireSubsystem } from '../../src/effects/fire/fire-subsystem.js';
import { createFireParticleEngine } from '../../src/effects/particles/fire-particle-runtime.js';
import { FIRE_PARAMS } from '../../src/effects/fire/fire.js';
import { extractFireSpawnPoints } from '../../src/effects/fire/fire-spawn-points.js';
import { saveCanvasPng, makeRunId } from './contract.js';

const TSL = THREE.TSL;
const q = new URLSearchParams(location.search);
const PRESENT = q.get('present') !== '0';
const STAGE_W = Number(q.get('w') ?? 960);
const STAGE_H = Number(q.get('h') ?? 720);
const SPAN = 4096;
const statusEl = document.getElementById('status');
const say = (m) => {
  if (statusEl) statusEl.textContent = m;
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const deepMerge = (a, b) => {
  const out = Array.isArray(a) ? [...a] : { ...a };
  for (const [k, v] of Object.entries(b ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a && typeof a[k] === 'object' && !Array.isArray(a[k]) ? deepMerge(a[k], v) : v;
  }
  return out;
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

const PARAM_DEFAULTS = Object.fromEntries(Object.entries(FIRE_PARAMS).map(([k, d]) => [k, d.default]));

async function main() {
  const canvas = document.getElementById('view');
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  await renderer.init();
  renderer.setSize(STAGE_W, STAGE_H, false);
  const stage = new THREE.RenderTarget(STAGE_W, STAGE_H, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, colorSpace: THREE.NoColorSpace, depthBuffer: false });
  stage.texture.minFilter = THREE.NearestFilter;
  stage.texture.magFilter = THREE.NearestFilter;

  const BASE = {
    zoom: 3,
    ground: 'dark',
    groundHex: '#222c26',
    camOffset: [14, 10],
    fires: [{ id: 'camp', x: 2048, y: 2300, diameterPx: 100, intensity: 1, outdoors01: 1, windExposure: 1, elevation: 0 }],
    // ⚠️ The spiralling embers (the real, unchanged ember engine) are tuned for the game's BLOOM: their HDR emission clips to
    // flat yellow discs here, so the lab dims them (and keeps them small) to read as sparks. A lab-only override.
    params: { emberEmission: 1.2, emberSizeScale: 1.6 },
    wind: { speed01: 0, directionDeg: 90, gust01: 0.4 },
    rain: 0,
    walls: null, // null (open ground) | 'room' (a sealed ring round fire 0) | 'wall' | 'doorway' (a ring with a gap east)
    roofed: false, // the painted _Outdoors reads dark everywhere (rain cannot reach)
  };
  let S = clone(BASE);
  let nowMs = 1000;
  let version = 1;

  // ── the wind handle (a real bake when there are walls) ───────────────────────────────────────────
  const uWind = TSL.uniform(TSL.float(0));
  const uDir = TSL.uniform(TSL.float(90));
  const uGust = TSL.uniform(TSL.float(0.4));
  let windHandle = W.createWindHandle({ ambientWind: { directionDeg: uDir, speed01: uWind, gustiness01: uGust } });
  const wl = (ax, ay, bx, by) => ({ x1: ax, y1: ay, x2: bx, y2: by, solid: true, blocksExterior: true });
  function wallsFor() {
    const f = S.fires[0];
    if (!S.walls) return null;
    const x0 = f.x - 300;
    const x1 = f.x + 300;
    const y0 = f.y - 300;
    const y1 = f.y + 300;
    if (S.walls === 'room') return [wl(x0, y0, x1, y0), wl(x1, y0, x1, y1), wl(x1, y1, x0, y1), wl(x0, y1, x0, y0)];
    if (S.walls === 'doorway') return [wl(x0, y0, x1, y0), wl(x1, y0, x1, f.y - 60), wl(x1, f.y + 60, x1, y1), wl(x1, y1, x0, y1), wl(x0, y1, x0, y0)];
    return [wl(f.x + 80, f.y - 400, f.x + 80, f.y + 400)];
  }
  function rebuildWind() {
    const walls = wallsFor();
    const ambient = { directionDeg: uDir, speed01: uWind, gustiness01: uGust };
    if (!walls) {
      windHandle = W.createWindHandle({ ambientWind: ambient });
      version++;
      return;
    }
    const gridSpec = W.computeWindBakeGridSpec({ sceneX: 0, sceneY: 0, sceneWidth: SPAN, sceneHeight: SPAN, gridSizePixels: 25, maxAxisCells: 512 });
    const structure = W.bakeWindStructure({ walls, gridSpec });
    windHandle = W.createWindHandle({
      version: ++version,
      grid: { originX: gridSpec.minX, originY: gridSpec.minY, cellSize: gridSpec.cellSize, cols: gridSpec.cols, rows: gridSpec.rows },
      cells: {
        solid: structure.solidMask,
        openness: W.deriveWindOpenness(structure, 1),
        wallAvoidDirX: structure.wallAvoidDirX,
        wallAvoidDirY: structure.wallAvoidDirY,
        wallProximity: structure.wallProximity,
        windShadow: W.deriveWindShadow(structure, S.wind.directionDeg),
        sky: S.roofed ? new Float32Array(gridSpec.cols * gridSpec.rows) : structure.sky,
      },
      ambientWind: ambient,
    });
  }

  // ── the painted spawn cloud (a disc per fire) ────────────────────────────────────────────────────
  function buildCloud() {
    const parts = S.fires.map((f) => {
      const texel = 10;
      const r = (f.diameterPx / 2) * 0.9;
      const N = Math.ceil((r * 2) / texel) + 2;
      const data = new Uint8Array(N * N);
      for (let y = 0; y < N; y++)
        for (let x = 0; x < N; x++) {
          const dx = (x + 0.5 - N / 2) * texel;
          const dy = (y + 0.5 - N / 2) * texel;
          data[y * N + x] = Math.hypot(dx, dy) <= r ? 255 : 0;
        }
      return extractFireSpawnPoints({ spec: { x: f.x - (N * texel) / 2, y: f.y - (N * texel) / 2, width: N * texel, height: N * texel, w: N, h: N, texelW: texel, texelH: texel }, data });
    });
    const total = parts.reduce((n, p) => n + p.count, 0);
    const points = new Float32Array(total * 4);
    let o = 0;
    for (const p of parts) {
      points.set(p.points.subarray(0, p.count * 4), o);
      o += p.count * 4;
    }
    return { points, count: total, paintedTexels: total, signature: (version * 7919 + total) | 0 };
  }

  // ── the allocator and the job runner (the viewer's two jobs) ──────────────────────────────────────
  const makeTarget = (name, w, h) => {
    const rt = new THREE.RenderTarget(w, h, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, colorSpace: THREE.NoColorSpace, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    rt.texture.wrapS = THREE.ClampToEdgeWrapping;
    rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    return rt;
  };
  function runFieldJobs(jobs) {
    if (!jobs.length) return;
    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    const prevColor = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    for (const job of jobs) {
      renderer.setRenderTarget(job.target);
      renderer.autoClear = true;
      renderer.clear(true, false, false);
      if (job.count > 0) {
        renderer.autoClear = false;
        renderer.render(job.scene, job.camera);
      }
    }
    renderer.autoClear = prevAuto;
    renderer.setClearColor(prevColor, prevAlpha);
    renderer.setRenderTarget(prevTarget);
  }

  let cloud = buildCloud();
  const state = () => ({ enabled: true, params: { ...PARAM_DEFAULTS, ...S.params }, perfTier: 3, mPerPx: 0.0102, fires: S.fires, spawnCloud: cloud, fireLabelGrid: null });
  let subsystem = null;
  function makeSubsystem() {
    subsystem?.dispose();
    subsystem = createFireSubsystem({
      THREE,
      getFireRenderState: state,
      getWindHandle: () => windHandle,
      getPxPerMeter: () => 100,
      getPrecip01: () => S.rain,
      createEngine: createFireParticleEngine,
      createTarget: makeTarget,
      disposeTarget: (rt) => rt.dispose(),
    });
  }

  // ── ground, camera ──────────────────────────────────────────────────────────────────────────────
  const groundScene = new THREE.Scene();
  const bgMaterial = new THREE.NodeMaterial();
  const uBg = TSL.uniform(TSL.vec3(0.02, 0.03, 0.025));
  bgMaterial.colorNode = TSL.vec4(uBg, TSL.float(1));
  bgMaterial.depthTest = false;
  bgMaterial.depthWrite = false;
  bgMaterial.side = THREE.DoubleSide;
  const bgMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), bgMaterial);
  bgMesh.frustumCulled = false;
  groundScene.add(bgMesh);
  const artCache = new Map();
  async function artMesh(url) {
    if (artCache.has(url)) return artCache.get(url);
    const res = await fetch(url);
    const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
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
    groundScene.add(mesh);
    const rec = { mesh, w: bmp.width, h: bmp.height };
    artCache.set(url, rec);
    return rec;
  }
  const camera = new THREE.OrthographicCamera(0, 1, 0, 1, -10, 10);
  const viewRect = () => {
    const f = S.fires[0];
    const w = STAGE_W / S.zoom;
    const h = STAGE_H / S.zoom;
    const cx = f.x + S.camOffset[0];
    const cy = f.y + S.camOffset[1];
    return { minX: cx - w / 2, maxX: cx + w / 2, minY: cy - h / 2, maxY: cy + h / 2 };
  };

  // ── one sim step ────────────────────────────────────────────────────────────────────────────────
  function step(dtSec) {
    nowMs += dtSec * 1000;
    uWind.value = S.wind.speed01;
    uDir.value = S.wind.directionDeg;
    uGust.value = S.wind.gust01;
    subsystem.sync(renderer, nowMs, dtSec, viewRect());
  }

  async function drawStage() {
    const rect = viewRect();
    camera.left = rect.minX;
    camera.right = rect.maxX;
    camera.top = rect.minY;
    camera.bottom = rect.maxY;
    camera.updateProjectionMatrix();
    const bg = new THREE.Color(S.groundHex);
    bg.convertSRGBToLinear();
    uBg.value.set(bg.r, bg.g, bg.b);
    bgMesh.position.set((rect.minX + rect.maxX) / 2, (rect.minY + rect.maxY) / 2, 0);
    bgMesh.scale.set(rect.maxX - rect.minX, rect.maxY - rect.minY, 1);
    for (const r of artCache.values()) r.mesh.visible = false;
    if (S.ground === 'logs') {
      const rec = await artMesh('/tools/shader-lab/dev/campsites/Camp_Fire_03.webp');
      for (const f of S.fires) {
        // one mesh serves every fire: draw the first, clone-free (the lab shows the ring under fire 0 only)
        const scale = f.diameterPx / 100;
        rec.mesh.position.set(f.x, f.y, 0);
        rec.mesh.scale.set(rec.w * scale, rec.h * scale, 1);
        rec.mesh.visible = true;
        break;
      }
    }
    renderer.setRenderTarget(stage);
    renderer.setClearColor(new THREE.Color(0, 0, 0), 1);
    renderer.autoClear = true;
    renderer.clear();
    renderer.autoClear = false;
    renderer.render(groundScene, camera);
    renderer.render(subsystem.scene, camera);
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
      for (let ch = 0; ch < 3; ch++) img.data[i * 4 + ch] = oetfByte(isHalf ? HALF_LUT[data[i * 4 + ch]] : data[i * 4 + ch]);
      img.data[i * 4 + 3] = 255;
    }
    c.getContext('2d').putImageData(img, 0, 0);
    return c;
  }
  const present = (c) => {
    if (PRESENT) canvas.getContext('2d')?.drawImage(c, 0, 0, canvas.width, canvas.height);
  };

  const runId = makeRunId('fire-engine');
  const lab = {
    ready: null,
    runId,
    get state() {
      return S;
    },
    configure(cfg = {}) {
      S = deepMerge(clone(BASE), cfg);
      cloud = buildCloud();
      rebuildWind();
      makeSubsystem();
      nowMs = 1000;
      return S;
    },
    /** Change the world without resetting the fires' state: params, wind, rain, roof. */
    patch(cfg = {}) {
      const wallsBefore = S.walls;
      const roofBefore = S.roofed;
      S = deepMerge(S, cfg);
      if (cfg.fires) cloud = buildCloud();
      if (S.walls !== wallsBefore || S.roofed !== roofBefore || cfg.fires) rebuildWind();
      return S;
    },
    setRain(v) {
      S.rain = v;
    },
    setWind(speed01, directionDeg) {
      S.wind.speed01 = speed01;
      if (directionDeg !== undefined) S.wind.directionDeg = directionDeg;
    },
    /** Step the whole subsystem `sec` seconds of fire clock at `dt`, without drawing. */
    async advance(sec, { dt = 1 / 30, draw = false } = {}) {
      const n = Math.max(1, Math.round(sec / dt));
      for (let i = 0; i < n; i++) {
        step(dt);
        const jobs = subsystem.takeFieldJobs();
        if (draw && i === n - 1) runFieldJobs(jobs);
      }
      return { steps: n, nowSec: nowMs / 1000 };
    },
    async frame() {
      step(1 / 30);
      runFieldJobs(subsystem.takeFieldJobs());
      await drawStage();
    },
    async shot(name = 'shot') {
      await lab.frame();
      const c = await stageCanvas();
      present(c);
      return { file: await saveCanvasPng(runId, `${name}.png`, c), run: runId, status: subsystem.getStatus().billow };
    },
    /**
     * A timeline: each step `{label, set?, advance?}` patches the world, advances the clock, and draws one tile. The fires
     * keep their state between tiles (this is how the rain cycle is shown).
     */
    async timeline(name, steps, { cols = 3, tilePx = 480, cropFire = 0 } = {}) {
      const rows = Math.ceil(steps.length / cols);
      const th = cropFire ? tilePx : Math.round((tilePx * STAGE_H) / STAGE_W);
      const out = document.createElement('canvas');
      out.width = tilePx * cols;
      out.height = th * rows;
      const ctx = out.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, out.width, out.height);
      const log = [];
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i];
        if (st.set) lab.patch(st.set);
        if (st.advance) await lab.advance(st.advance, { dt: st.dt ?? 0.25 });
        await lab.frame();
        const c = await stageCanvas();
        const ox = (i % cols) * tilePx;
        const oy = Math.floor(i / cols) * th;
        if (cropFire) {
          const rect = viewRect();
          const f = S.fires[0];
          const bx = (f.x - rect.minX) * S.zoom;
          const by = (f.y - rect.minY) * S.zoom;
          ctx.drawImage(c, bx - cropFire, by - cropFire, cropFire * 2, cropFire * 2, ox, oy, tilePx, th);
        } else ctx.drawImage(c, ox, oy, tilePx, th);
        const lf = subsystem.getLives()?.get(S.fires[0].id);
        const label = `${st.label ?? i}${lf ? `  [${lf.phase} v${lf.vitality.toFixed(2)} c${lf.coal.toFixed(2)}]` : ''}`;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(ox + 4, oy + 4, Math.min(tilePx - 8, 14 + label.length * 7.2), 20);
        ctx.fillStyle = '#fff';
        ctx.font = '13px monospace';
        ctx.fillText(label, ox + 10, oy + 19);
        log.push({ label: st.label, lf: lf ? { ...lf } : null });
      }
      present(out);
      return { file: await saveCanvasPng(runId, `${name}.png`, out), run: runId, log };
    },
    /** A PNG sequence for a video; `fn(i)` returns `{set?, advance?}` for frame i. */
    async video(name, frames, fn, { dt = 1 / 24, size } = {}) {
      const files = [];
      for (let i = 0; i < frames; i++) {
        const st = fn ? fn(i) : {};
        if (st.set) lab.patch(st.set);
        await lab.advance(st.advance ?? dt, { dt: Math.min(st.dt ?? dt, 0.25) });
        await lab.frame();
        let c = await stageCanvas();
        if (size) {
          const o = document.createElement('canvas');
          o.width = size[0];
          o.height = size[1];
          o.getContext('2d').drawImage(c, 0, 0, size[0], size[1]);
          c = o;
        }
        files.push(await saveCanvasPng(runId, `${name}_${String(i).padStart(4, '0')}.png`, c));
      }
      return { run: runId, frames: files.length, first: files[0], last: files[files.length - 1] };
    },
    lives() {
      const book = subsystem.getLives();
      const out = {};
      for (const f of S.fires) {
        const l = book?.get(f.id);
        if (l) out[f.id] = { ...l };
      }
      return out;
    },
    setLife(id, partial) {
      subsystem.getLives()?.set(id, partial);
    },
    status: () => subsystem.getStatus(),
    lights: () => subsystem.lightSources().map((l) => ({ id: l.sourceId, luminosity01: l.luminosity01, alpha01: l.alpha01, radius: l.radius })),
  };

  lab.ready = (async () => {
    lab.configure({});
    say('fire engine lab ready');
    return true;
  })();
  window.fireEngineLab = lab;
  await lab.ready;
}

main().catch((e) => {
  say(`FAILED: ${e?.stack ?? e}`);
  console.error('[lab] fire engine lab failed', e);
});
