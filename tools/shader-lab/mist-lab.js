/**
 * SHADER LAB — GROUND MIST (mmp-63o.1, 2026-11-07).
 *
 * The Fog weather axis (`fogDensity01`) drawn by the PRODUCTION module (`ground-mist-render.js`) over a real map,
 * lit the way the viewer lights it: a stand-in `scene.illum` (the hour's ambient, darker indoors, a few lamp pools
 * with hard edges so the mist's light spread is judgeable), the ground = albedo × illum, then the mist on top,
 * gated by the map's real `_Outdoors` mask. Indoors must stay clear; the mist must thin toward walls.
 *
 * Map art is not in the repo: `runs/mist-art/<map>.jpg` and `<map>-out.png` (a crop of the map and its mask).
 * Time is hand-stepped. `mist.driver.shot(...)` renders and POSTs a PNG under `runs/<run>/`.
 *
 * @module tools/shader-lab/mist-lab
 */
import { createGroundMist } from '../../src/effects/precipitation/ground-mist-render.js';
import { createWindAdvectionState } from '../../src/world/index.js';

/** The lab hours: the ground's light (linear RGB) outdoors, indoors, and whether the lamps burn. */
export const MIST_HOURS = Object.freeze({
  noon: { out: [1.0, 1.0, 1.0], ind: [0.55, 0.55, 0.58], lamps: 0, label: 'noon' },
  dawn: { out: [0.72, 0.66, 0.66], ind: [0.32, 0.31, 0.34], lamps: 0.6, label: 'dawn' },
  dusk: { out: [0.95, 0.56, 0.32], ind: [0.36, 0.26, 0.22], lamps: 1, label: 'dusk (golden)' },
  night: { out: [0.07, 0.09, 0.16], ind: [0.04, 0.045, 0.07], lamps: 1, label: 'night' },
});

/** Map crops: image size, world size (the crop's real map px), lamps in IMAGE px (x right, y down). */
export const MIST_MAPS = Object.freeze({
  dock: {
    img: [1600, 900],
    world: [4500, 2531],
    lamps: [
      [1400, 527, 520],
      [1012, 690, 520],
      [1375, 765, 460],
      [16, 810, 460],
      [957, 262, 700],
    ],
  },
});

export class MistLabDriver {
  constructor({ THREE }) {
    this.THREE = THREE;
    this.renderer = new THREE.WebGPURenderer({ antialias: false, alpha: false });
    this.ready = this.init();
    this.nowMs = 0;
  }

  get backend() {
    return this.renderer?.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2';
  }

  async init() {
    const THREE = this.THREE;
    const T = THREE.TSL;
    await this.renderer.init();
    this.W = 1600;
    this.H = 900;
    this.renderer.setSize(this.W, this.H, false);
    const rtOpts = { type: THREE.HalfFloatType, depthBuffer: false };
    this.illumRT = new THREE.RenderTarget(this.W, this.H, rtOpts);
    this.sceneRT = new THREE.RenderTarget(this.W, this.H, rtOpts);
    this.outRT = new THREE.RenderTarget(this.W, this.H, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat });
    this.outRT.texture.colorSpace = THREE.SRGBColorSpace;
    this.camera = new THREE.OrthographicCamera(0, 1, 1, 0, 0.1, 1000);
    this.camera.position.set(0, 0, 100);
    const open = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
    open.needsUpdate = true;
    this.openSky = open;
    this.u = {
      out: T.uniform(T.vec3(1, 1, 1)),
      ind: T.uniform(T.vec3(0.5, 0.5, 0.5)),
      lamps: T.uniform(T.float(0)),
      world: T.uniform(T.vec2(1, 1)),
      l0: T.uniform(T.vec3(0, 0, 1)),
      l1: T.uniform(T.vec3(0, 0, 1)),
      l2: T.uniform(T.vec3(0, 0, 1)),
      l3: T.uniform(T.vec3(0, 0, 1)),
      l4: T.uniform(T.vec3(0, 0, 1)),
    };
    this.windHandle = {
      ambient: {
        speed01: T.uniform(T.float(0)),
        directionDeg: T.uniform(T.float(90)),
        advection: createWindAdvectionState(),
      },
    };
    this.maps = new Map();
  }

  async loadMap(id) {
    if (this.maps.has(id)) return this.maps.get(id);
    const THREE = this.THREE;
    const T = THREE.TSL;
    const spec = MIST_MAPS[id];
    const loader = new THREE.TextureLoader();
    const albedo = await loader.loadAsync(`/tools/shader-lab/runs/mist-art/${id}.jpg`);
    albedo.colorSpace = THREE.SRGBColorSpace;
    // The gate as the viewer builds it: an RGBA8 DataTexture with CPU bytes, row 0 = minY (bottom), flipY false —
    // the mist builds its blurred copy from those bytes.
    const outImg = await loader.loadAsync(`/tools/shader-lab/runs/mist-art/${id}-out.png`).then((t) => t.image);
    const cv = document.createElement('canvas');
    cv.width = outImg.width;
    cv.height = outImg.height;
    const cx = cv.getContext('2d');
    cx.drawImage(outImg, 0, 0);
    const px = cx.getImageData(0, 0, cv.width, cv.height).data;
    const gw = cv.width;
    const gh = cv.height;
    const gate = new Uint8Array(gw * gh * 4);
    for (let y = 0; y < gh; y++) gate.set(px.subarray((gh - 1 - y) * gw * 4, (gh - y) * gw * 4), y * gw * 4);
    const outdoors = new THREE.DataTexture(gate, gw, gh, THREE.RGBAFormat, THREE.UnsignedByteType);
    outdoors.minFilter = THREE.LinearFilter;
    outdoors.magFilter = THREE.LinearFilter;
    outdoors.needsUpdate = true;
    const [ww, wh] = spec.world;
    const rect = { minX: 0, minY: 0, maxX: ww, maxY: wh };
    const plane = new THREE.PlaneGeometry(ww, wh);
    plane.translate(ww / 2, wh / 2, 0);
    const { float, vec2, vec3, texture, uv, positionGeometry, smoothstep, max, screenUV } = T;
    const u = this.u;
    // THE STAND-IN ILLUM: ambient by indoor/outdoor, plus hard-edged lamp pools (a wall cuts them).
    const outd = texture(outdoors, uv()).r;
    const amb = vec3(u.ind).mul(float(1).sub(outd)).add(vec3(u.out).mul(outd));
    const xy = positionGeometry.xy;
    const lamp = (l) => {
      const d = xy.sub(l.xy).length();
      const fall = float(1).sub(smoothstep(float(0), l.z, d));
      return fall.mul(fall);
    };
    const pools = lamp(u.l0).add(lamp(u.l1)).add(lamp(u.l2)).add(lamp(u.l3)).add(lamp(u.l4));
    const illumMat = new THREE.MeshBasicNodeMaterial();
    illumMat.colorNode = T.vec4(amb.add(vec3(1.6, 1.05, 0.55).mul(pools).mul(u.lamps)), float(1));
    illumMat.depthTest = false;
    illumMat.side = THREE.DoubleSide;
    const groundMat = new THREE.MeshBasicNodeMaterial();
    groundMat.colorNode = T.vec4(texture(albedo, uv()).rgb.mul(texture(this.illumRT.texture, screenUV).rgb), float(1));
    groundMat.depthTest = false;
    groundMat.side = THREE.DoubleSide;
    const illumScene = new THREE.Scene();
    illumScene.add(new THREE.Mesh(plane, illumMat));
    const groundScene = new THREE.Scene();
    groundScene.add(new THREE.Mesh(plane, groundMat));
    for (const s of [illumScene, groundScene]) s.children[0].frustumCulled = false;
    const mist = createGroundMist({
      THREE,
      worldRect: rect,
      openSkyTexture: this.openSky,
      illumTexture: this.illumRT.texture,
      // The viewer's own door (vt-pan-viewer.js#createMistGateTexture), restated.
      createGateTexture: ({ data, w, h }) => {
        const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
        t.minFilter = THREE.LinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.needsUpdate = true;
        return t;
      },
    });
    mist.setSkyReachTexture(outdoors, rect);
    const presentMat = new THREE.MeshBasicNodeMaterial();
    presentMat.colorNode = T.vec4(texture(this.sceneRT.texture, screenUV).rgb, float(1));
    presentMat.depthTest = false;
    presentMat.side = THREE.DoubleSide;
    const presentScene = new THREE.Scene();
    presentScene.add(new THREE.Mesh(plane, presentMat));
    presentScene.children[0].frustumCulled = false;
    const entry = { spec, rect, albedo, outdoors, illumScene, groundScene, presentScene, mist, max, vec2 };
    this.maps.set(id, entry);
    return entry;
  }

  /** Set the hour, density, wind, view. */
  async configure({ map = 'dock', hour = 'noon', density = 0.7, wind = 0, windDir = 90, view = null } = {}) {
    const m = await this.loadMap(map);
    const h = MIST_HOURS[hour] ?? MIST_HOURS.noon;
    const u = this.u;
    u.out.value.set(...h.out);
    u.ind.value.set(...h.ind);
    u.lamps.value = h.lamps;
    const [iw, ih] = m.spec.img;
    const [ww, wh] = m.spec.world;
    const ls = [u.l0, u.l1, u.l2, u.l3, u.l4];
    ls.forEach((lu, i) => {
      const l = m.spec.lamps[i];
      if (l) lu.value.set((l[0] / iw) * ww, ((ih - l[1]) / ih) * wh, l[2]);
      else lu.value.set(-1e6, -1e6, 1);
    });
    this.windHandle.ambient.speed01.value = wind;
    this.windHandle.ambient.directionDeg.value = windDir;
    const v = view ?? m.rect;
    this.camera.left = v.minX;
    this.camera.right = v.maxX;
    this.camera.bottom = v.minY;
    this.camera.top = v.maxY;
    this.camera.updateProjectionMatrix();
    m.mist.setFrame({ density01: density, lightRgb: h.out });
    this.cur = { map, hour, density, wind, m };
    return this.cur;
  }

  advance(frames = 1, dtMs = 1000 / 60) {
    for (let i = 0; i < frames; i++) this.nowMs += dtMs;
    this.cur?.m.mist.step(this.nowMs, this.windHandle);
  }

  /** Draw illum → ground → (mist) into the scene target, then present into the 8-bit target. */
  draw({ mist = true } = {}) {
    const r = this.renderer;
    const m = this.cur.m;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.illumRT);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.render(m.illumScene, this.camera);
    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(m.groundScene, this.camera);
    if (mist && m.mist.hasContent) {
      const prevAuto = r.autoClear;
      r.autoClear = false;
      r.render(m.mist.scene, this.camera);
      r.autoClear = prevAuto;
    }
    r.setRenderTarget(this.outRT);
    r.clear();
    r.render(m.presentScene, this.camera);
    r.setRenderTarget(prev);
  }

  async shot(run, file, o = {}) {
    await this.configure(o);
    this.advance(o.warmFrames ?? 2, o.dtMs ?? 1000 / 60);
    this.draw({ mist: o.mist !== false });
    const bytes = await this.renderer.readRenderTargetPixelsAsync(this.outRT, 0, 0, this.W, this.H);
    const label =
      o.label ??
      `${MIST_HOURS[o.hour ?? 'noon'].label} · fog ${Math.round((o.density ?? 0.7) * 100)}%` +
        (o.wind ? ` · wind ${Math.round(o.wind * 100)}%` : '');
    return this.savePng(run, file, bytes, label);
  }

  /** RGBA bytes (bottom row first from a render target) to a PNG under runs/<run>/<file>. */
  async savePng(run, file, bytes, label) {
    const w = this.W;
    const h = this.H;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    img.data.set(bytes.subarray(0, w * h * 4));
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    ctx.putImageData(img, 0, 0);
    if (label) {
      ctx.font = '600 22px ui-monospace, monospace';
      const lw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, 0, lw + 22, 38);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, 11, 27);
    }
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    const resp = await fetch(`/__lab/artifact?run=${encodeURIComponent(run)}&file=${encodeURIComponent(file)}`, {
      method: 'POST',
      body: blob,
    });
    return resp.ok;
  }

  /**
   * GPU cost of the mist draw at the lab's 1600×900: `n` draws of the ground alone vs ground + mist, each batch
   * timed to `onSubmittedWorkDone`. Returns ms per draw for both and the difference.
   */
  async cost(n = 120) {
    const r = this.renderer;
    const device = r.backend?.device;
    const m = this.cur.m;
    const time = async (withMist) => {
      r.setRenderTarget(this.sceneRT);
      const prevAuto = r.autoClear;
      r.autoClear = false;
      await device.queue.onSubmittedWorkDone();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        r.render(m.groundScene, this.camera);
        if (withMist) r.render(m.mist.scene, this.camera);
      }
      await device.queue.onSubmittedWorkDone();
      const ms = performance.now() - t0;
      r.autoClear = prevAuto;
      r.setRenderTarget(null);
      return ms / n;
    };
    await time(true); // warm
    const base = await time(false);
    const both = await time(true);
    const base2 = await time(false);
    const both2 = await time(true);
    const b = Math.min(base, base2);
    const w = Math.min(both, both2);
    return { n, groundMsPerDraw: b, groundPlusMistMsPerDraw: w, mistMs: w - b, px: this.W * this.H };
  }
}
