/**
 * SHADER LAB — THE FIRE BILLOW LAB. The new fire, judged from above AND from the side.
 *
 * Imports the REAL `fire-billow-geometry.js` (the lobe model) and `fire-billow-render.js` (splat + contour) from
 * `src/`; nothing here is transcribed. The lab supplies a ground, a camera, a clock and a fire descriptor.
 *
 *   await fireBillowLab.ready
 *   fireBillowLab.configure({ fire: { radius: 50, outdoor01: 1 }, view: 'top', ground: 'logs', t: 12 })
 *   await fireBillowLab.shot('calm')                       // one PNG under tools/shader-lab/runs/<run>/
 *   await fireBillowLab.sheet('winds', [{label:'calm', cfg:{}}, {label:'gale', cfg:{fire:{windMotion01:1, windX:1}}}])
 *   await fireBillowLab.video('cycle', 90, 1/24, (i) => ({ t: 10 + i / 24 }))   // a PNG sequence
 *
 * Everything is a closed-form function of the clock, so any instant renders on its own and time can be scrubbed.
 * Headless: `?present=0`. Orientation is CALIBRATED (`calibrate()`), never assumed.
 *
 * ⚠️ No bloom and no scene lighting here: this answers "what does the flame LOOK like" (shape, colour, motion,
 * height) against the painted campfires, not how it sits in a lit night scene. Lab-green is BUILT (unverified).
 *
 * @module tools/shader-lab/fire-billow-lab
 */
import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { createBillowRenderer, BILLOW_LOOK } from '../../src/effects/fire/fire-billow-render.js';
import { emitFireLobes, BILLOW_TUNE, LOBE_STRIDE, maxLobesPerFire } from '../../src/effects/fire/fire-billow-geometry.js';
import { fireScaleChain } from '../../src/effects/fire/fire-geometry.js';
import { saveCanvasPng, makeRunId } from './contract.js';

const TSL = THREE.TSL;
const q = new URLSearchParams(location.search);
const PRESENT = q.get('present') !== '0';
const STAGE_W = Number(q.get('w') ?? 960);
const STAGE_H = Number(q.get('h') ?? 720);
const statusEl = document.getElementById('status');
const say = (m) => {
  if (statusEl) statusEl.textContent = m;
};

/** IEEE half -> number. */
function halfToFloat(h) {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  let v;
  if (e === 0) v = f * 2 ** -24;
  else if (e === 0x1f) v = f ? NaN : Infinity;
  else v = (f / 1024 + 1) * 2 ** (e - 15);
  return s ? -v : v;
}
const HALF_LUT = new Float32Array(65536);
for (let i = 0; i < 65536; i++) HALF_LUT[i] = halfToFloat(i);
/** linear 0..1 -> sRGB byte. */
function oetfByte(c) {
  const v = Math.max(0, Math.min(1, c));
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const deepMerge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof a?.[k] === 'object' ? deepMerge(a[k], v) : v;
  }
  return out;
};

async function main() {
  const canvas = document.getElementById('view');
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
  await renderer.init();
  renderer.setSize(STAGE_W, STAGE_H, false);

  // ── the stage target (HDR, linear) ─────────────────────────────────────────────────────────────
  const stage = new THREE.RenderTarget(STAGE_W, STAGE_H, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.NoColorSpace,
    depthBuffer: false,
  });
  stage.texture.minFilter = THREE.NearestFilter;
  stage.texture.magFilter = THREE.NearestFilter;

  // The lab stands in for the viewer: it supplies the allocator (`createTarget`) and runs the splat jobs
  // (`tickFireField` in vt-pan-viewer.js does the same two things in the game).
  const makeTarget = (name, w, h) => {
    const rt = new THREE.RenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
    rt.texture.wrapS = THREE.ClampToEdgeWrapping;
    rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    rt.texture.name = name;
    return rt;
  };
  const billow = createBillowRenderer({ THREE, createTarget: makeTarget, disposeTarget: (rt) => rt.dispose() });
  function runFieldJobs(jobs) {
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

  // ── the lab's state ───────────────────────────────────────────────────────────────────────────
  const BASE = {
    t: 12,
    zoom: 3,
    view: 'top',
    ground: 'dark', // 'dark' | 'logs' | 'logs-lit' (the painted reference, no fire of ours)
    groundHex: '#222c26',
    parallax: 1,
    camOffset: [14, 10], // view centre minus fire, world px — slightly off-centre so height shows a little parallax
    tilt: 0.3,
    quality: 1,
    fire: {
      x: 2000,
      y: 2000,
      radius: 50,
      seed: 7,
      intensity: 1,
      outdoor01: 1,
      turb01: 1,
      puffHz: 1.6,
      flickerAmp: 0.3,
      windX: 1,
      windY: 0,
      windMotion01: 0,
      stress01: 0,
      vitality01: 1,
      rain01: 0,
      smokeMul: 1,
    },
    tune: {},
    look: {},
  };
  let S = clone(BASE);

  // ── ground ────────────────────────────────────────────────────────────────────────────────────
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

  const textures = new Map();
  async function loadTexture(url) {
    if (textures.has(url)) return textures.get(url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`cannot load ${url}: ${res.status}`);
    const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const tex = new THREE.Texture(bmp);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.flipY = false;
    tex.needsUpdate = true;
    const rec = { tex, w: bmp.width, h: bmp.height };
    textures.set(url, rec);
    return rec;
  }
  const artMeshes = new Map();
  function artMesh(url, rec) {
    if (artMeshes.has(url)) return artMeshes.get(url);
    const mat = new THREE.NodeMaterial();
    const node = TSL.texture(rec.tex);
    const c = node.sample(TSL.uv());
    mat.colorNode = TSL.vec4(c.rgb, c.a);
    mat.transparent = true;
    mat.depthTest = false;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;
    mat.toneMapped = false;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    mesh.frustumCulled = false;
    groundScene.add(mesh);
    artMeshes.set(url, mesh);
    return mesh;
  }
  const GROUND_ART = {
    logs: '/tools/shader-lab/dev/campsites/Camp_Fire_03.webp',
    'logs-lit': '/tools/shader-lab/dev/campsites/Camp_Fire_04.webp',
    'logs-pile': '/tools/shader-lab/dev/campsites/Camp_Fire_02.webp',
    'ring-lit': '/tools/shader-lab/dev/campsites/Camp_Fire_06.webp',
  };

  // ── view geometry ─────────────────────────────────────────────────────────────────────────────
  function viewRect() {
    const w = STAGE_W / S.zoom;
    const h = STAGE_H / S.zoom;
    if (S.view === 'side') {
      const groundY = S.fire.y;
      const minY = groundY - 0.82 * h;
      return { minX: S.fire.x - w / 2, maxX: S.fire.x + w / 2, minY, maxY: minY + h, groundY };
    }
    const cx = S.fire.x + S.camOffset[0];
    const cy = S.fire.y + S.camOffset[1];
    return { minX: cx - w / 2, maxX: cx + w / 2, minY: cy - h / 2, maxY: cy + h / 2, groundY: 0 };
  }
  const camera = new THREE.OrthographicCamera(0, 1, 0, 1, -10, 10);

  const chainFor = (fire) => fireScaleChain(fire.radius * 2, 0.0102, { fuel: 'wood', intensity: fire.intensity });

  /** One frame: lobes -> field -> ground -> contour, into the stage target. */
  async function renderFrame() {
    const rect = viewRect();
    const fire = { ...S.fire };
    const chain = chainFor(fire);
    fire.turb01 = fire.turb01 ?? chain.turb01;
    fire.puffHz = fire.puffHz ?? chain.puffHz;
    fire.flickerAmp = fire.flickerAmp ?? chain.flickerAmp;
    const env = {
      tSec: S.t,
      camX: (rect.minX + rect.maxX) / 2,
      camY: (rect.minY + rect.maxY) / 2,
      parallax: S.parallax,
      tilt: S.tilt,
      projection: S.view,
      groundY: rect.groundY,
      quality: S.quality,
    };
    const n = emitFireLobes(billow.flameLobes, 0, fire, env, S.tune, billow.smokeLobes, 0);
    billow.setCounts(n.count, n.smoke);
    billow.setLook({ ...BILLOW_LOOK, ...S.look });
    runFieldJobs(billow.prepareField(rect, { pxPerWorld: S.zoom, timeSec: S.t }));
    billow.setQuad(rect.minX, rect.minY, rect.maxX - rect.minX, rect.maxY - rect.minY);

    camera.left = rect.minX;
    camera.right = rect.maxX;
    camera.top = rect.minY;
    camera.bottom = rect.maxY;
    camera.updateProjectionMatrix();

    // ground
    const bg = new THREE.Color(S.groundHex);
    bg.convertSRGBToLinear();
    uBg.value.set(bg.r, bg.g, bg.b);
    bgMesh.position.set((rect.minX + rect.maxX) / 2, (rect.minY + rect.maxY) / 2, 0);
    bgMesh.scale.set(rect.maxX - rect.minX, rect.maxY - rect.minY, 1);
    bgMesh.visible = true;
    for (const m of artMeshes.values()) m.visible = false;
    if (S.view === 'top' && GROUND_ART[S.ground]) {
      const url = GROUND_ART[S.ground];
      const rec = await loadTexture(url);
      const mesh = artMesh(url, rec);
      // the log ring is 162 px for a ~100 px flame: art px == world px at the author's scale
      const scale = (S.fire.radius * 2) / 100;
      mesh.position.set(S.fire.x, S.fire.y, 0);
      mesh.scale.set(rec.w * scale, rec.h * scale, 1);
      mesh.visible = true;
    }
    if (S.view === 'side') {
      // a ground line: fill below groundY a little lighter
      bgMesh.visible = true;
    }

    renderer.setRenderTarget(stage);
    renderer.setClearColor(new THREE.Color(0, 0, 0), 1);
    renderer.autoClear = true;
    renderer.clear();
    renderer.autoClear = false;
    renderer.render(groundScene, camera);
    renderer.render(billow.scene, camera);
    renderer.autoClear = true;
    renderer.setRenderTarget(null);
    return { rect, lobes: n };
  }

  async function readStage() {
    const raw = await renderer.readRenderTargetPixelsAsync(stage, 0, 0, STAGE_W, STAGE_H);
    const data = raw instanceof Promise ? await raw : raw;
    return data;
  }

  /** Stage -> an 8-bit canvas (sRGB encode, clamp). Readback rows are top-down in this renderer (calibrated). */
  async function stageCanvas() {
    const data = await readStage();
    const c = document.createElement('canvas');
    c.width = STAGE_W;
    c.height = STAGE_H;
    const img = new ImageData(STAGE_W, STAGE_H);
    const isHalf = data instanceof Uint16Array;
    for (let y = 0; y < STAGE_H; y++) {
      const srcY = flipRows ? STAGE_H - 1 - y : y;
      for (let x = 0; x < STAGE_W; x++) {
        const si = (srcY * STAGE_W + x) * 4;
        const di = (y * STAGE_W + x) * 4;
        for (let ch = 0; ch < 3; ch++) img.data[di + ch] = oetfByte(isHalf ? HALF_LUT[data[si + ch]] : data[si + ch]);
        img.data[di + 3] = 255;
      }
    }
    c.getContext('2d').putImageData(img, 0, 0);
    return c;
  }
  let flipRows = false;

  function present(c) {
    if (!PRESENT) return;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.drawImage(c, 0, 0, canvas.width, canvas.height);
  }

  const runId = makeRunId('fire-billow');

  const lab = {
    ready: null,
    runId,
    BASE,
    get state() {
      return S;
    },
    /** Reset to the baseline, then apply a patch. */
    configure(cfg = {}) {
      S = deepMerge(clone(BASE), cfg);
      return S;
    },
    /** Apply a patch on top of the CURRENT state. */
    patch(cfg = {}) {
      S = deepMerge(S, cfg);
      return S;
    },
    async frame(cfg) {
      if (cfg) S = deepMerge(S, cfg);
      return renderFrame();
    },
    /** Render the current state and save one PNG. */
    async shot(name = 'shot', cfg) {
      if (cfg) S = deepMerge(S, cfg);
      const info = await renderFrame();
      const c = await stageCanvas();
      present(c);
      const file = `${name}.png`;
      const saved = await saveCanvasPng(runId, file, c);
      return { file: saved, run: runId, lobes: info.lobes };
    },
    /** A contact sheet of states. Each tile = the BASE patched by its `cfg` (so tiles do not leak into each other). */
    async sheet(name, tiles, { cols = 3, tilePx = 480, label = true, base, cropFire = 0 } = {}) {
      const rows = Math.ceil(tiles.length / cols);
      const out = document.createElement('canvas');
      const th = cropFire ? tilePx : Math.round((tilePx * STAGE_H) / STAGE_W);
      out.width = tilePx * cols;
      out.height = th * rows;
      const ctx = out.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, out.width, out.height);
      const saved = S;
      for (let i = 0; i < tiles.length; i++) {
        S = deepMerge(deepMerge(clone(BASE), base ?? {}), tiles[i].cfg ?? {});
        await renderFrame();
        const c = await stageCanvas();
        const ox = (i % cols) * tilePx;
        const oy = Math.floor(i / cols) * th;
        if (cropFire) {
          // a square window round the fire's base (screen px = world px * zoom), drawn 1:1 and scaled to the tile
          const r = viewRect();
          const bx = (S.fire.x - r.minX) * S.zoom;
          const by = (S.fire.y - r.minY) * S.zoom;
          ctx.drawImage(c, bx - cropFire, by - cropFire, cropFire * 2, cropFire * 2, ox, oy, tilePx, th);
        } else ctx.drawImage(c, ox, oy, tilePx, th);
        if (label) {
          ctx.fillStyle = 'rgba(0,0,0,0.6)';
          ctx.fillRect(ox + 4, oy + 4, Math.min(tilePx - 8, 8 + ctx.measureText(tiles[i].label ?? '').width * 1.2 + 140), 20);
          ctx.fillStyle = '#fff';
          ctx.font = '13px monospace';
          ctx.fillText(tiles[i].label ?? `#${i}`, ox + 10, oy + 19);
        }
      }
      S = saved;
      present(out);
      const saved1 = await saveCanvasPng(runId, `${name}.png`, out);
      return { file: saved1, run: runId, tiles: tiles.length };
    },
    /** A PNG sequence (for a video). `cfgFn(i)` returns the patch for frame i. Saved as `<name>_0000.png`... */
    async video(name, frames, dt, cfgFn, { size } = {}) {
      const saved = S;
      const files = [];
      for (let i = 0; i < frames; i++) {
        S = deepMerge(clone(saved), cfgFn ? cfgFn(i) : { t: saved.t + i * dt });
        await renderFrame();
        const c = await stageCanvas();
        let out = c;
        if (size) {
          out = document.createElement('canvas');
          out.width = size[0];
          out.height = size[1];
          out.getContext('2d').drawImage(c, 0, 0, size[0], size[1]);
        }
        const file = `${name}_${String(i).padStart(4, '0')}.png`;
        files.push(await saveCanvasPng(runId, file, out));
      }
      S = saved;
      return { run: runId, frames: files.length, first: files[0], last: files[files.length - 1] };
    },
    /**
     * NUMBERS, NOT EYEBALLS: render `tiles` instants and measure the flame the way the painted art was measured
     * (warm, saturated, bright pixels; tone = nearest painted palette colour). Returns tone shares, area and shape.
     */
    async measure(cfg = {}, { tiles = 8, dt = 0.55, t0 = 12 } = {}) {
      const saved = S;
      const keys = ['cream', 'yellow', 'amber', 'orange', 'dark'];
      const palette = { cream: [254, 222, 112], yellow: [253, 191, 63], amber: [251, 162, 24], orange: [250, 137, 7], dark: [211, 122, 29] };
      const acc = { cream: 0, yellow: 0, amber: 0, orange: 0, dark: 0 };
      let area = 0;
      let wSum = 0;
      let hSum = 0;
      for (let i = 0; i < tiles; i++) {
        S = deepMerge(deepMerge(clone(BASE), { ground: 'dark', groundHex: '#222c26' }), { ...cfg, t: t0 + i * dt });
        await renderFrame();
        const data = await readStage();
        const isHalf = data instanceof Uint16Array;
        const mask = new Uint8Array(STAGE_W * STAGE_H);
        let n = 0;
        for (let p = 0; p < STAGE_W * STAGE_H; p++) {
          const r = oetfByte(isHalf ? HALF_LUT[data[p * 4]] : data[p * 4]);
          const g = oetfByte(isHalf ? HALF_LUT[data[p * 4 + 1]] : data[p * 4 + 1]);
          const b = oetfByte(isHalf ? HALF_LUT[data[p * 4 + 2]] : data[p * 4 + 2]);
          const mx = Math.max(r, g, b);
          const mn = Math.min(r, g, b);
          const v = mx;
          const sat = mx === 0 ? 0 : ((mx - mn) / mx) * 255;
          let h = 0;
          if (mx !== mn) {
            if (mx === r) h = ((g - b) / (mx - mn)) * 60;
            else if (mx === g) h = (2 + (b - r) / (mx - mn)) * 60;
            else h = (4 + (r - g) / (mx - mn)) * 60;
            if (h < 0) h += 360;
          }
          const hcv = h / 2;
          if (hcv >= 5 && hcv <= 35 && sat >= 90 && v >= 190) {
            mask[p] = 1;
            n++;
            let best = null;
            let bd = 1e12;
            for (const k of keys) {
              const c = palette[k];
              const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
              if (d < bd) {
                bd = d;
                best = k;
              }
            }
            acc[best]++;
          }
        }
        // the largest connected component's bounding box (flecks do not count toward the flame size)
        const seen = new Uint8Array(mask.length);
        let bestBox = null;
        let bestSize = 0;
        const stack = [];
        for (let p0 = 0; p0 < mask.length; p0++) {
          if (!mask[p0] || seen[p0]) continue;
          let size = 0;
          let x0 = STAGE_W;
          let x1 = 0;
          let y0 = STAGE_H;
          let y1 = 0;
          stack.length = 0;
          stack.push(p0);
          seen[p0] = 1;
          while (stack.length) {
            const p = stack.pop();
            size++;
            const x = p % STAGE_W;
            const y = (p - x) / STAGE_W;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
            if (x > 0 && mask[p - 1] && !seen[p - 1]) (seen[p - 1] = 1), stack.push(p - 1);
            if (x < STAGE_W - 1 && mask[p + 1] && !seen[p + 1]) (seen[p + 1] = 1), stack.push(p + 1);
            if (y > 0 && mask[p - STAGE_W] && !seen[p - STAGE_W]) (seen[p - STAGE_W] = 1), stack.push(p - STAGE_W);
            if (y < STAGE_H - 1 && mask[p + STAGE_W] && !seen[p + STAGE_W]) (seen[p + STAGE_W] = 1), stack.push(p + STAGE_W);
          }
          if (size > bestSize) {
            bestSize = size;
            bestBox = [x1 - x0 + 1, y1 - y0 + 1];
          }
        }
        area += n;
        if (bestBox) {
          wSum += bestBox[0];
          hSum += bestBox[1];
        }
      }
      S = saved;
      const total = Object.values(acc).reduce((a, b) => a + b, 0) || 1;
      const shares = Object.fromEntries(keys.map((k) => [k, acc[k] / total]));
      return { shares, area: area / tiles, w: wSum / tiles, h: hSum / tiles };
    },
    /**
     * Coordinate descent on look uniforms (and tune values) to match the painted flame's measured statistics.
     * `params`: [{ target:'look'|'tune', key, lo, hi, step }]. Returns the winning values and the loss trace.
     */
    async fit(params, { iters = 3, tiles = 6, targetOverride } = {}) {
      const TARGET = targetOverride ?? { shares: { cream: 0.105, yellow: 0.136, amber: 0.277, orange: 0.343, dark: 0.138 }, area: 31400, aspect: 0.97 };
      const cur = {};
      for (const p of params) cur[`${p.target}.${p.key}`] = (p.target === 'look' ? S.look[p.key] ?? BILLOW_LOOK[p.key] : S.tune[p.key] ?? BILLOW_TUNE[p.key]) ?? p.start;
      const lossOf = (m) => {
        let l = 0;
        for (const k of Object.keys(TARGET.shares)) l += Math.abs(m.shares[k] - TARGET.shares[k]);
        l += 0.6 * Math.abs(m.area / TARGET.area - 1);
        l += 0.4 * Math.abs(m.h / Math.max(1, m.w) - TARGET.aspect);
        return l;
      };
      const evalAt = async (values) => {
        const look = {};
        const tune = {};
        for (const p of params) (p.target === 'look' ? look : tune)[p.key] = values[`${p.target}.${p.key}`];
        const m = await lab.measure({ look: { ...S.look, ...look }, tune: { ...S.tune, ...tune } }, { tiles });
        return { m, loss: lossOf(m) };
      };
      let best = await evalAt(cur);
      const trace = [Number(best.loss.toFixed(4))];
      for (let it = 0; it < iters; it++) {
        for (const p of params) {
          const key = `${p.target}.${p.key}`;
          for (const dir of [1, -1]) {
            const trial = { ...cur, [key]: Math.max(p.lo, Math.min(p.hi, cur[key] + dir * p.step * (1 - it * 0.25))) };
            if (trial[key] === cur[key]) continue;
            const r = await evalAt(trial);
            if (r.loss < best.loss) {
              best = r;
              cur[key] = trial[key];
              trace.push(Number(r.loss.toFixed(4)));
              break;
            }
          }
        }
      }
      return { values: cur, loss: best.loss, measured: best.m, trace };
    },
    /** The lobe records of the current state, for numbers (positions, radii, heights). */
    lobes() {
      const rect = viewRect();
      const fire = { ...S.fire };
      const chain = chainFor(fire);
      const env = { tSec: S.t, camX: (rect.minX + rect.maxX) / 2, camY: (rect.minY + rect.maxY) / 2, parallax: S.parallax, projection: S.view, groundY: rect.groundY, quality: S.quality };
      const buf = new Float32Array(maxLobesPerFire(fire.radius) * LOBE_STRIDE);
      const sbuf = new Float32Array(maxLobesPerFire(fire.radius) * LOBE_STRIDE);
      fire.turb01 = fire.turb01 ?? chain.turb01;
      const n = emitFireLobes(buf, 0, fire, env, S.tune, sbuf, 0);
      return { n, buf, sbuf, stride: LOBE_STRIDE };
    },
    /**
     * Orientation: put ONE lobe at a known world position near the view's top-left and find where it lands in the
     * stage readback and in the field. A Y-flip anywhere (field texture, readback rows) makes this fail loudly.
     */
    async calibrate() {
      const saved = S;
      S = deepMerge(clone(BASE), { ground: 'none', view: 'top', camOffset: [0, 0], zoom: 2 });
      const rect = viewRect();
      // one lobe at 25% across, 20% down the world rect
      const wx = rect.minX + (rect.maxX - rect.minX) * 0.25;
      const wy = rect.minY + (rect.maxY - rect.minY) * 0.2;
      billow.flameLobes.fill(0);
      billow.flameLobes.set([wx, wy, 40, 2.4, 1, 1, 1, 0, 0, 0.1, 1, 0], 0);
      billow.setCounts(1, 0);
      billow.setLook({ ...BILLOW_LOOK });
      runFieldJobs(billow.prepareField(rect, { pxPerWorld: S.zoom }));
      billow.setQuad(rect.minX, rect.minY, rect.maxX - rect.minX, rect.maxY - rect.minY);
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
      renderer.render(billow.scene, camera);
      renderer.autoClear = true;
      renderer.setRenderTarget(null);
      const data = await readStage();
      const isHalf = data instanceof Uint16Array;
      let sx = 0;
      let sy = 0;
      let sw = 0;
      for (let y = 0; y < STAGE_H; y++) {
        for (let x = 0; x < STAGE_W; x++) {
          const i = (y * STAGE_W + x) * 4;
          const v = isHalf ? HALF_LUT[data[i]] + HALF_LUT[data[i + 1]] + HALF_LUT[data[i + 2]] : data[i] + data[i + 1] + data[i + 2];
          if (v > 0.05) {
            sx += x * v;
            sy += y * v;
            sw += v;
          }
        }
      }
      S = saved;
      const cx = sw > 0 ? sx / sw / STAGE_W : null;
      const cy = sw > 0 ? sy / sw / STAGE_H : null;
      return { lit: sw > 0, centroidU: cx, centroidV: cy, expectedU: 0.25, expectedV: 0.2, rowsTopDown: cy !== null && Math.abs(cy - 0.2) < 0.05, rowsFlipped: cy !== null && Math.abs(cy - 0.8) < 0.05 };
    },
  };

  lab.ready = (async () => {
    const cal = await lab.calibrate();
    if (cal.rowsFlipped) flipRows = true;
    say(`fire billow lab ready — WebGPU, ${STAGE_W}x${STAGE_H}; orientation ${cal.rowsTopDown ? 'top-down' : cal.rowsFlipped ? 'FLIPPED (corrected)' : 'UNKNOWN'} ${JSON.stringify(cal)}`);
    return cal;
  })();
  window.fireBillowLab = lab;
  await lab.ready;
}

main().catch((e) => {
  say(`FAILED: ${e?.stack ?? e}`);
  console.error('[lab] fire billow lab failed', e);
});
