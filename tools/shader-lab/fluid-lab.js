/**
 * SHADER LAB — FLUID (2026-11-04).
 *
 * The author: *"It needs to look like magical fluid rushing down glass pipes. It needs to be fun, dynamic,
 * animated and ideally it should be unpredictable, show 'reactions' where things suddenly change ... The fluid
 * should be self illuminating and illuminate the map around it with a subtle light."*
 *
 * A test bed that works the way the viewer does on Wizard's Lair, so a picture here is a picture of the real
 * thing:
 *   - the REAL `createFluidSurfaceSubsystem` (tube net → pack → pump → GPU sim → materials), fed the REAL
 *     `_Glassware_Fluid` mask through the REAL loader (`vt/mask-image.js`), on the Glassware tile's own world
 *     rect (x 1800, y 1800, 6750 square), host renderOrder and all;
 *   - the scene drawn in the viewer's order: ground → fluid (absorb, under its host) → the Glassware tile;
 *   - the light composite with the viewer's own formula (`environmental-light.js`):
 *       lit = EOTF( OETF(scene) × illum + coloration )
 *     where illum = the ambient level MAX-blended with the fluid's own light sources (if the subsystem offers
 *     any), drawn with a simple windowed falloff — a stand-in for the point-light pool, judged for placement and
 *     strength here and for real on the rig;
 *   - the post-light draws (`emitScene`, if the subsystem has one) added onto lit, as the viewer adds flames;
 *   - a quarter-res bloom and the present pass's own highlight roll-off (`grade-ops.js`).
 *
 * Time is HAND-STEPPED (the Browser pane may be hidden): `advance(seconds)` ticks the sim at 60 Hz.
 * Map art is not in the repo: `runs/art-lair/` holds a crop of Ground + Glassware and the full Fluid mask.
 *
 * Drive it: `fluidLab.describe()`, `fluidLab.set({...})`, `fluidLab.view('lab')`, `fluidLab.light('night')`,
 * `fluidLab.job(() => fluidLab.sheet({run, file, times}))` then poll `fluidLab.last`.
 *
 * @module tools/shader-lab/fluid-lab
 */
import * as THREE from '../../src/vendor/three/three.webgpu.js';
import { createFluidSurfaceSubsystem } from '../../src/effects/fluid/fluid-surface-subsystem.js';
import { loadMaskImageTexture } from '../../src/vt/mask-image.js';
import { FLUID_PARAMS } from '../../src/effects/fluid/fluid.js';
import { buildHighlightRolloffNode } from '../../src/effects/grade/grade-ops.js';
import { hexToRgb01 } from '../../src/effects/candle-flame-geometry.js';
import { QUAD_UVS, QUAD_INDICES } from '../../src/scene/world-quad.js';

const T = THREE.TSL;
const ART = '/tools/shader-lab/runs/art-lair/';
/** The Glassware tile (and its `_Fluid` mask) on Wizard's Lair, world px. */
const TILE = Object.freeze({ x: 1800, y: 1800, w: 6750, h: 6750 });
/** The crop of Ground/Glassware art the lab carries (image px 1500..6500 × 3500..6300). */
const CROP = Object.freeze({ x: 3300, y: 5300, w: 5000, h: 2800 });
const W = 1600;
const H = 900;
const HOST_RO = 10;

export const VIEWS = Object.freeze({
  wide: { cx: 5800, cy: 6745, w: 4800 },
  lab: { cx: 6900, cy: 6150, w: 1780 },
  left: { cx: 4300, cy: 7000, w: 1500 },
  coil: { cx: 6300, cy: 5760, w: 1300 },
  bottom: { cx: 6650, cy: 7450, w: 1900 },
  flask: { cx: 7020, cy: 6390, w: 760 },
});

/** Ambient illum per time of day — roughly what the viewer's illum buffer holds on the Lair. */
export const LIGHTING = Object.freeze({
  // `exposure`: the viewer's Dynamic Range camera exposes the night up (+1.5 EV measured on the Lair rig, ×2.8);
  // without it the lab's goo read correctly at a glow the real viewer bleached white.
  night: { ambient: [0.12, 0.14, 0.22], bloom: 1, exposure: 2.8 },
  dusk: { ambient: [0.5, 0.4, 0.42], bloom: 0.8, exposure: 1.6 },
  day: { ambient: [1, 1, 1], bloom: 0.6, exposure: 1 },
});

function schemaDefaults() {
  const out = {};
  for (const [k, d] of Object.entries(FLUID_PARAMS)) out[k] = d.default;
  return out;
}

/** A world-space quad, the viewer's own corner order (TL, TR, BR, BL; uv 0,0 = top-left). */
function worldQuadGeometry(x, y, w, h) {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([x, y, 0, x + w, y, 0, x + w, y + h, 0, x, y + h, 0]), 3)
  );
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(QUAD_UVS), 2));
  g.setIndex(Array.from(QUAD_INDICES));
  g.computeBoundingSphere();
  return g;
}

async function loadArt(url) {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob, { imageOrientation: 'none', premultiplyAlpha: 'none' });
  const tex = new THREE.Texture(bmp);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

class FluidLab {
  constructor() {
    this.canvas = document.getElementById('view');
    this.renderer = new THREE.WebGPURenderer({ canvas: this.canvas, antialias: false, alpha: false });
    this.params = schemaDefaults();
    this.lab = {
      tier: 7,
      lighting: 'night',
      ambient: [...LIGHTING.night.ambient],
      bloom: LIGHTING.night.bloom,
      exposure: LIGHTING.night.exposure,
      bloomThreshold: 0.9,
      lightGain: 1,
      glass: 1,
      speed: 1,
      view: 'lab',
      labels: true,
    };
    this.tMs = 0;
    this.frames = 0;
    this.playing = false;
    this.busy = false;
    this.last = null;
    this.ready = this.init();
  }

  get backend() {
    return this.renderer?.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2';
  }

  async init() {
    const r = this.renderer;
    await r.init();
    r.setPixelRatio(1);
    r.setSize(W, H, false);
    r.outputColorSpace = THREE.LinearSRGBColorSpace;
    r.toneMapping = THREE.NoToneMapping;

    this.camera = new THREE.OrthographicCamera(0, 1, 0, 1, 0.1, 1000);
    this.camera.position.set(0, 0, 100);
    this.setView(this.lab.view);

    const rt = (w, h, type = THREE.HalfFloatType) => {
      const t = new THREE.RenderTarget(w, h, { type, format: THREE.RGBAFormat, depthBuffer: false });
      t.texture.minFilter = THREE.LinearFilter;
      t.texture.magFilter = THREE.LinearFilter;
      t.texture.colorSpace = THREE.NoColorSpace;
      return t;
    };
    // scene.color is an MRT in the viewer (`vt/scene-attr.js`): `output` + `attr`. The fluid materials declare an
    // `attr` override, which only compiles against a renderer-global MRT that also names `output`.
    this.sceneRT = new THREE.RenderTarget(W, H, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      count: 2,
    });
    this.sceneRT.textures[0].name = 'output';
    this.sceneRT.textures[1].name = 'attr';
    for (const t of this.sceneRT.textures) {
      t.colorSpace = THREE.NoColorSpace;
      t.minFilter = t.magFilter = THREE.LinearFilter;
    }
    this.sceneMrt = T.mrt({ output: T.output, attr: T.vec4(0, 0, 0, 0) });
    this.illumRT = rt(W, H);
    this.colorRT = rt(W, H);
    this.litRT = rt(W, H);
    this.bloomA = rt(W / 4, H / 4);
    this.bloomB = rt(W / 4, H / 4);
    this.bloomC = rt(W / 8, H / 8);
    this.bloomD = rt(W / 8, H / 8);
    this.presentRT = rt(W, H, THREE.UnsignedByteType);

    // ── the world ────────────────────────────────────────────────────────────
    this.uTimeMs = T.uniform(T.float(0));
    this.worldScene = new THREE.Scene();
    const [ground, glass] = await Promise.all([loadArt(ART + 'ground.webp'), loadArt(ART + 'glass.webp')]);
    this.groundTex = ground;
    this.glassTex = glass;
    const gm = new THREE.NodeMaterial();
    gm.colorNode = T.vec4(T.texture(ground, T.uv()).rgb, 1);
    gm.side = THREE.DoubleSide;
    gm.depthTest = false;
    gm.depthWrite = false;
    this.groundMesh = new THREE.Mesh(worldQuadGeometry(CROP.x, CROP.y, CROP.w, CROP.h), gm);
    this.groundMesh.renderOrder = 0;
    this.groundMesh.frustumCulled = false;
    this.worldScene.add(this.groundMesh);

    this.uGlass = T.uniform(T.float(1));
    const glm = new THREE.NodeMaterial();
    const gs = T.texture(glass, T.uv());
    glm.colorNode = T.vec4(gs.rgb, gs.a.mul(this.uGlass));
    glm.transparent = true;
    glm.side = THREE.DoubleSide;
    glm.depthTest = false;
    glm.depthWrite = false;
    this.glassMesh = new THREE.Mesh(worldQuadGeometry(CROP.x, CROP.y, CROP.w, CROP.h), glm);
    this.glassMesh.renderOrder = HOST_RO;
    this.glassMesh.frustumCulled = false;
    this.worldScene.add(this.glassMesh);

    // ── the real subsystem ───────────────────────────────────────────────────
    const corners = [
      { x: TILE.x, y: TILE.y },
      { x: TILE.x + TILE.w, y: TILE.y },
      { x: TILE.x + TILE.w, y: TILE.y + TILE.h },
      { x: TILE.x, y: TILE.y + TILE.h },
    ];
    this.item = {
      id: 'tile:glassware',
      url: ART + 'fluid.png',
      hostUrl: ART + 'glass-full.webp',
      corners,
      renderOrder: HOST_RO,
    };
    this.sub = createFluidSurfaceSubsystem({
      THREE,
      scene: this.worldScene,
      getFluidMaskItems: () => [this.item],
      loadMaskImage: (url) => loadMaskImageTexture({ url, THREE }),
      createPackTexture: (data, w, h) => {
        const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.flipY = false;
        tex.needsUpdate = true;
        return tex;
      },
      createSimRenderTarget: (name, w, h) => rt(w, h),
      disposeSimRenderTarget: (t) => t.dispose(),
      getFluidRenderState: () => this.renderState(),
      timeMsNode: this.uTimeMs,
      // The host tile's own art, decoded small — the same seam the viewer fills (`vt-pan-viewer.js`).
      loadHostImage: async (url, maxDim) => {
        const blob = await (await fetch(url)).blob();
        const probe = await createImageBitmap(blob);
        const s = Math.min(1, maxDim / Math.max(probe.width, probe.height));
        const w = Math.round(probe.width * s);
        const h = Math.round(probe.height * s);
        probe.close();
        const bmp = await createImageBitmap(blob, {
          resizeWidth: w,
          resizeHeight: h,
          resizeQuality: 'high',
          premultiplyAlpha: 'none',
        });
        const c = new OffscreenCanvas(w, h);
        const ctx = c.getContext('2d');
        ctx.drawImage(bmp, 0, 0);
        bmp.close();
        return { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h };
      },
      createGateTexture: (data, w, h) => {
        const tex = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.UnsignedByteType);
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.flipY = false;
        tex.needsUpdate = true;
        return tex;
      },
    });

    // ── light stand-ins (the point-light pool's job in the viewer) ───────────
    this.lightScene = new THREE.Scene();
    this.colorScene = new THREE.Scene();
    this.lightMeshes = [];

    // ── composite / bloom / present ──────────────────────────────────────────
    this.uAmbient = T.uniform(T.vec3(...this.lab.ambient));
    const sceneTex = T.texture(this.sceneRT.textures[0]);
    const illumTex = T.texture(this.illumRT.texture);
    const colTex = T.texture(this.colorRT.texture);
    const litSrgb = T.sRGBTransferOETF(T.max(sceneTex.rgb, T.vec3(0)))
      .mul(illumTex.rgb)
      .add(colTex.rgb);
    const comp = new THREE.NodeMaterial();
    comp.fragmentNode = T.vec4(T.sRGBTransferEOTF(litSrgb), 1);
    this.compositeQuad = new THREE.QuadMesh(comp);

    this.uBloomThr = T.uniform(T.float(this.lab.bloomThreshold));
    this.uBloom = T.uniform(T.float(this.lab.bloom));
    const bright = new THREE.NodeMaterial();
    const lc = T.texture(this.litRT.texture);
    const lm = T.max(T.max(lc.r, lc.g), lc.b);
    bright.fragmentNode = T.vec4(lc.rgb.mul(T.smoothstep(this.uBloomThr, this.uBloomThr.add(0.6), lm)), 1);
    this.brightQuad = new THREE.QuadMesh(bright);
    const blur = (src, w, h, dx, dy) => {
      const m = new THREE.NodeMaterial();
      const wts = [0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216];
      let acc = T.texture(src, T.uv()).rgb.mul(wts[0]);
      for (let i = 1; i < 5; i++) {
        const o = T.vec2((dx * i * 1.5) / w, (dy * i * 1.5) / h);
        acc = acc.add(T.texture(src, T.uv().add(o)).rgb.mul(wts[i]));
        acc = acc.add(T.texture(src, T.uv().sub(o)).rgb.mul(wts[i]));
      }
      m.fragmentNode = T.vec4(acc, 1);
      return new THREE.QuadMesh(m);
    };
    this.blurs = {
      ah: blur(this.bloomA.texture, W / 4, H / 4, 1, 0),
      bv: blur(this.bloomB.texture, W / 4, H / 4, 0, 1),
      ch: blur(this.bloomA.texture, W / 8, H / 8, 1, 0),
      dv: blur(this.bloomC.texture, W / 8, H / 8, 0, 1),
    };
    this.uExposure = T.uniform(T.float(this.lab.exposure));
    const pres = new THREE.NodeMaterial();
    const hdr = T.texture(this.litRT.texture)
      .rgb.add(T.texture(this.bloomA.texture).rgb.mul(this.uBloom).mul(0.6))
      .add(T.texture(this.bloomD.texture).rgb.mul(this.uBloom).mul(0.5))
      .mul(this.uExposure);
    pres.fragmentNode = T.vec4(T.sRGBTransferOETF(T.clamp(buildHighlightRolloffNode(T, hdr), 0, 1)), 1);
    this.presentQuad = new THREE.QuadMesh(pres);

    this.buildPanel();
    // Bake: sync until the subsystem has the item baked.
    for (let i = 0; i < 400; i++) {
      this.sub.sync(0);
      const st = this.sub.getStatus();
      if (st.items?.some((it) => it.tubeCount > 0 || it.baked)) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    await this.compile();
    this.status();
    return true;
  }

  renderState() {
    const p = this.params;
    return {
      enabled: true,
      params: {
        ...p,
        tint: typeof p.tint === 'string' ? hexToRgb01(p.tint) : p.tint,
        accent: typeof p.accent === 'string' ? hexToRgb01(p.accent) : p.accent,
      },
      perfTier: this.lab.tier,
    };
  }

  async compile() {
    // Render once so every pipeline is built before timed work.
    this.tick(1 / 60);
    this.render(false);
    await new Promise((r) => setTimeout(r, 50));
  }

  setView(name) {
    const v = typeof name === 'string' ? VIEWS[name] : name;
    if (!v) throw new Error(`unknown view ${name}`);
    if (typeof name === 'string') this.lab.view = name;
    const h = (v.w * H) / W;
    const c = this.camera;
    c.left = v.cx - v.w / 2;
    c.right = v.cx + v.w / 2;
    c.top = v.cy - h / 2;
    c.bottom = v.cy + h / 2;
    c.updateProjectionMatrix();
  }

  setLighting(name) {
    const l = LIGHTING[name];
    if (!l) throw new Error(`unknown lighting ${name}`);
    this.lab.lighting = name;
    this.lab.ambient = [...l.ambient];
    this.lab.bloom = l.bloom;
    this.lab.exposure = l.exposure;
  }

  /** Change fluid params (schema keys) and/or lab keys. */
  set(o = {}) {
    for (const [k, v] of Object.entries(o)) {
      if (k in this.lab) this.lab[k] = v;
      else this.params[k] = v;
    }
    if (o.view) this.setView(o.view);
    if (o.lighting) this.setLighting(o.lighting);
    this.syncPanel?.();
  }

  /** Reset the clock and the sim to empty tubes (a fresh bake of the sim state). */
  reset() {
    this.tMs = 0;
    this.frames = 0;
    this.sub.resetSim?.();
  }

  tick(dtSec) {
    this.tMs += dtSec * 1000;
    this.frames++;
    this.uTimeMs.value = this.tMs;
    this.sub.sync(0);
    const r = this.renderer;
    const { clears, advects } = this.sub.prepareSimTick(this.tMs, dtSec);
    const prev = r.getRenderTarget();
    if (clears.length) {
      r.setClearColor(0x000000, 0);
      for (const t of clears) {
        r.setRenderTarget(t);
        r.clear(true, false, false);
      }
    }
    for (const { quad, destRT } of advects) {
      r.setRenderTarget(destRT);
      quad.render(r);
    }
    r.setRenderTarget(prev);
  }

  /** Step the clock `seconds` forward at a fixed 60 Hz. */
  advance(seconds, hz = 60) {
    const n = Math.max(0, Math.round(seconds * hz));
    for (let i = 0; i < n; i++) this.tick(1 / hz);
  }

  syncLights() {
    const list = (this.sub.lightSources?.() ?? []).slice(0, 48);
    while (this.lightMeshes.length < list.length) {
      const u = {
        lum: T.uniform(T.float(0)),
        color: T.uniform(T.vec3(1, 1, 1)),
        alpha: T.uniform(T.float(0)),
        ratio: T.uniform(T.float(0.3)),
      };
      const d = T.length(T.uv().sub(0.5)).mul(2);
      const fall = T.pow(T.clamp(T.float(1).sub(d), 0, 1), 2);
      const core = T.float(1).sub(T.smoothstep(u.ratio, T.float(1), d));
      const lmat = new THREE.NodeMaterial();
      lmat.fragmentNode = T.vec4(T.vec3(u.lum.mul(2).mul(T.max(fall, core.mul(0.6)))), 1);
      lmat.blending = THREE.CustomBlending;
      lmat.blendEquation = THREE.MaxEquation;
      lmat.blendSrc = THREE.OneFactor;
      lmat.blendDst = THREE.OneFactor;
      lmat.depthTest = false;
      lmat.depthWrite = false;
      lmat.transparent = true;
      lmat.side = THREE.DoubleSide; // the lab camera is y-flipped: FrontSide would cull every light
      const cmat = new THREE.NodeMaterial();
      cmat.fragmentNode = T.vec4(u.color.mul(u.alpha).mul(fall).mul(0.55), 1);
      cmat.blending = THREE.AdditiveBlending;
      cmat.depthTest = false;
      cmat.depthWrite = false;
      cmat.transparent = true;
      cmat.side = THREE.DoubleSide;
      const geo = new THREE.PlaneGeometry(1, 1);
      const lm = new THREE.Mesh(geo, lmat);
      const cm = new THREE.Mesh(geo, cmat);
      lm.frustumCulled = false;
      cm.frustumCulled = false;
      this.lightScene.add(lm);
      this.colorScene.add(cm);
      this.lightMeshes.push({ lm, cm, u });
    }
    this.lightMeshes.forEach((m, i) => {
      const L = list[i];
      m.lm.visible = m.cm.visible = !!L;
      if (!L) return;
      for (const mesh of [m.lm, m.cm]) {
        mesh.position.set(L.x, L.y, 0);
        mesh.scale.set(L.radius * 2, L.radius * 2, 1);
      }
      m.u.lum.value = (L.luminosity01 ?? 0.3) * this.lab.lightGain;
      m.u.alpha.value = (L.alpha01 ?? 0.5) * this.lab.lightGain;
      m.u.ratio.value = L.ratio ?? 0.3;
      m.u.color.value.set(...(L.color ?? [1, 1, 1]));
    });
    return list.length;
  }

  /** Draw one frame. `toCanvas` also shows it. */
  render(toCanvas = true) {
    const r = this.renderer;
    this.uAmbient.value.set(...this.lab.ambient);
    this.uBloom.value = this.lab.bloom;
    this.uExposure.value = this.lab.exposure;
    this.uBloomThr.value = this.lab.bloomThreshold;
    this.uGlass.value = this.lab.glass;
    const prevAuto = r.autoClear;
    // scene colour
    r.setRenderTarget(this.sceneRT);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.autoClear = false;
    r.setMRT(this.sceneMrt);
    r.render(this.worldScene, this.camera);
    r.setMRT(null);
    // illum = ambient MAX lights; coloration = Σ light colour
    this.syncLights();
    r.setRenderTarget(this.illumRT);
    r.setClearColor(new THREE.Color(...this.lab.ambient), 1);
    r.clear();
    r.render(this.lightScene, this.camera);
    r.setRenderTarget(this.colorRT);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.render(this.colorScene, this.camera);
    // composite
    r.setRenderTarget(this.litRT);
    this.compositeQuad.render(r);
    // post-light draws (flame-like): the fluid's own glow, if the subsystem draws it here
    if (this.sub.emitScene) r.render(this.sub.emitScene, this.camera);
    // bloom
    r.setRenderTarget(this.bloomA);
    this.brightQuad.render(r);
    r.setRenderTarget(this.bloomB);
    this.blurs.ah.render(r);
    r.setRenderTarget(this.bloomA);
    this.blurs.bv.render(r);
    r.setRenderTarget(this.bloomC);
    this.blurs.ch.render(r);
    r.setRenderTarget(this.bloomD);
    this.blurs.dv.render(r);
    // present
    r.setRenderTarget(this.presentRT);
    this.presentQuad.render(r);
    if (toCanvas) {
      r.setRenderTarget(null);
      this.presentQuad.render(r);
    }
    r.setRenderTarget(null);
    r.autoClear = prevAuto;
  }

  async frameBytes() {
    this.render(true);
    const bytes = await this.renderer.readRenderTargetPixelsAsync(this.presentRT, 0, 0, W, H);
    return { bytes, w: W, h: H };
  }

  toCanvas({ bytes, w, h }, label, scale = 1) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    img.data.set(bytes.subarray(0, w * h * 4));
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    ctx.putImageData(img, 0, 0);
    let out = c;
    if (scale !== 1) {
      out = document.createElement('canvas');
      out.width = Math.round(w * scale);
      out.height = Math.round(h * scale);
      out.getContext('2d').drawImage(c, 0, 0, out.width, out.height);
    }
    if (label && this.lab.labels) {
      const ctx2 = out.getContext('2d');
      const fs = Math.max(12, Math.round(20 * Math.min(1, scale * 1.4)));
      ctx2.font = `600 ${fs}px ui-monospace, monospace`;
      const lines = String(label).split('\n');
      const lw = Math.max(...lines.map((l) => ctx2.measureText(l).width));
      ctx2.fillStyle = 'rgba(0,0,0,0.62)';
      ctx2.fillRect(0, 0, lw + 16, 8 + lines.length * (fs + 4));
      ctx2.fillStyle = '#fff';
      lines.forEach((l, i) => ctx2.fillText(l, 8, fs + 2 + i * (fs + 4)));
    }
    return out;
  }

  async post(run, file, canvas, type = 'image/png', quality = 0.92) {
    const blob = await new Promise((res) => canvas.toBlob(res, type, quality));
    const resp = await fetch(`/__lab/artifact?run=${encodeURIComponent(run)}&file=${encodeURIComponent(file)}`, {
      method: 'POST',
      body: blob,
    });
    return resp.ok;
  }

  /**
   * One still: `o.reset` restarts the sim, then the clock runs to `o.t` seconds (from now, or from 0 after a
   * reset) and the frame is saved as runs/<run>/<file>.
   */
  async shot({ run, file, view, lighting, params, t = 6, reset = true, label } = {}) {
    if (params) this.set(params);
    if (view) this.setView(view);
    if (lighting) this.setLighting(lighting);
    if (reset) this.reset();
    this.advance(t);
    const f = await this.frameBytes();
    const ok = await this.post(run, file, this.toCanvas(f, label ?? `${file}  t=${(this.tMs / 1000).toFixed(1)}s`));
    return { ok, t: this.tMs / 1000 };
  }

  /** A contact sheet: frames at `times` (seconds after a reset), `cols` wide, each scaled by `scale`. */
  async sheet({ run, file, view, lighting, params, times = [2, 4, 6, 8, 10, 12], cols = 3, scale = 0.5, title } = {}) {
    if (params) this.set(params);
    if (view) this.setView(view);
    if (lighting) this.setLighting(lighting);
    this.reset();
    const tiles = [];
    for (const t of [...times].sort((a, b) => a - b)) {
      this.advance(Math.max(0, t - this.tMs / 1000));
      const f = await this.frameBytes();
      tiles.push(this.toCanvas(f, `${title ? title + '  ' : ''}t=${t.toFixed(1)}s`, scale));
    }
    const tw = tiles[0].width;
    const th = tiles[0].height;
    const rows = Math.ceil(tiles.length / cols);
    const c = document.createElement('canvas');
    c.width = tw * cols;
    c.height = th * rows;
    const ctx = c.getContext('2d');
    tiles.forEach((tile, i) => ctx.drawImage(tile, (i % cols) * tw, Math.floor(i / cols) * th));
    const ok = await this.post(run, file, c, 'image/jpeg', 0.9);
    return { ok, frames: tiles.length };
  }

  /** A clip: `seconds` of frames at `fps` as JPEGs runs/<run>/<prefix>_NNNN.jpg (assemble offline). */
  async clip({
    run,
    prefix = 'f',
    view,
    lighting,
    params,
    seconds = 6,
    fps = 30,
    warm = 4,
    scale = 0.6,
    reset = true,
  } = {}) {
    if (params) this.set(params);
    if (view) this.setView(view);
    if (lighting) this.setLighting(lighting);
    if (reset) this.reset();
    this.advance(warm);
    const n = Math.round(seconds * fps);
    for (let i = 0; i < n; i++) {
      if (i) this.advance(1 / fps, fps * 2);
      const f = await this.frameBytes();
      await this.post(
        run,
        `${prefix}_${String(i).padStart(4, '0')}.jpg`,
        this.toCanvas(f, null, scale),
        'image/jpeg',
        0.88
      );
    }
    return { frames: n };
  }

  /**
   * THE METER (round 3, 2026-11-04 — "too bright in all places at once ... more gaps"). Splits the goo's own
   * light from the scene so contrast is a number, not an impression:
   *   coverage  tube pixels in view (the _Fluid mask > 0.5, drawn with the same world quad);
   *   filled    share of those holding liquid (the absorb pass alone, on white, darkens by > 4%);
   *   bright    share whose EMIT alone, × the lab exposure, exceeds `brightAt` (linear luma);
   *   mean/p95  the emit luma over the tube, × exposure.
   * Samples `samples` frames `every` seconds apart after `warm` seconds and reports each plus the averages.
   */
  async meter({ view, lighting, params, warm = 6, samples = 8, every = 1.5, brightAt = 0.35, reset = true } = {}) {
    if (params) this.set(params);
    if (view) this.setView(view);
    if (lighting) this.setLighting(lighting);
    const r = this.renderer;
    if (!this.meterRT) {
      this.meterRT = new THREE.RenderTarget(W, H, {
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        depthBuffer: false,
      });
      this.meterRT.texture.colorSpace = THREE.NoColorSpace;
      const tex = await new THREE.TextureLoader().loadAsync(ART + 'fluid.png');
      tex.flipY = false;
      tex.needsUpdate = true;
      const m = new THREE.NodeMaterial();
      m.fragmentNode = T.vec4(T.vec3(T.step(T.float(0.5), T.texture(tex, T.uv()).r)), 1);
      m.side = THREE.DoubleSide;
      m.depthTest = false;
      this.coverScene = new THREE.Scene();
      this.coverScene.add(new THREE.Mesh(worldQuadGeometry(TILE.x, TILE.y, TILE.w, TILE.h), m));
    }
    const read = async (scene, clear) => {
      r.setRenderTarget(this.meterRT);
      r.setClearColor(clear, 1);
      r.clear();
      r.render(scene, this.camera);
      r.setRenderTarget(null);
      return r.readRenderTargetPixelsAsync(this.meterRT, 0, 0, W, H);
    };
    const meshes = this.sub.emitScene.children;
    const isAbsorb = (o) => o.material?.blendDst === THREE.SrcColorFactor;
    const cover = await read(this.coverScene, 0x000000);
    if (reset) this.reset();
    this.advance(warm);
    const exp = this.lab.exposure;
    const rows = [];
    for (let s = 0; s < samples; s++) {
      if (s) this.advance(every);
      this.render(false);
      meshes.forEach((o) => (o.visible = !isAbsorb(o)));
      const em = await read(this.sub.emitScene, 0x000000);
      meshes.forEach((o) => (o.visible = isAbsorb(o)));
      const ab = await read(this.sub.emitScene, 0xffffff);
      meshes.forEach((o) => (o.visible = true));
      let n = 0;
      let filled = 0;
      let bright = 0;
      let sum = 0;
      const lums = [];
      for (let i = 0; i < W * H; i++) {
        if (cover[i * 4] < 128) continue;
        n++;
        const L = ((0.2126 * em[i * 4] + 0.7152 * em[i * 4 + 1] + 0.0722 * em[i * 4 + 2]) / 255) * exp;
        sum += L;
        if (L > brightAt) bright++;
        if ((ab[i * 4] + ab[i * 4 + 1] + ab[i * 4 + 2]) / 765 < 0.96) filled++;
        if ((i & 7) === 0) lums.push(L);
      }
      lums.sort((a, b) => a - b);
      const pct = (x) => Math.round((x / Math.max(1, n)) * 1000) / 10;
      rows.push({
        t: Math.round(this.tMs / 100) / 10,
        filled: pct(filled),
        bright: pct(bright),
        mean: Math.round((sum / Math.max(1, n)) * 1000) / 1000,
        p95: Math.round((lums[Math.floor(lums.length * 0.95)] ?? 0) * 1000) / 1000,
      });
    }
    const avg = (k) => Math.round((rows.reduce((a, b) => a + b[k], 0) / rows.length) * 100) / 100;
    const span = (k) => [Math.min(...rows.map((x) => x[k])), Math.max(...rows.map((x) => x[k]))];
    return {
      coverage: rows.length ? undefined : 0,
      avg: { filled: avg('filled'), bright: avg('bright'), mean: avg('mean'), p95: avg('p95') },
      brightRange: span('bright'),
      filledRange: span('filled'),
      rows,
    };
  }

  /** Run an async job in the background (a tool call dies at 45 s); poll `fluidLab.last`. */
  job(fn) {
    this.last = 'pending';
    this.busy = true;
    Promise.resolve()
      .then(fn)
      .then(
        (v) => (this.last = v),
        (e) => (this.last = 'ERROR ' + String((e && e.stack) || e))
      )
      .finally(() => (this.busy = false));
    return 'started';
  }

  describe() {
    return {
      backend: this.backend,
      views: Object.keys(VIEWS),
      lighting: Object.keys(LIGHTING),
      params: this.params,
      lab: this.lab,
      status: this.sub.getStatus(),
      api: 'set({...}), view(name), light(name), reset(), advance(s), shot({run,file,t}), sheet({run,file,times}), clip({run,prefix,seconds}), job(fn)',
    };
  }

  view(n) {
    this.setView(n);
    this.syncPanel?.();
  }

  light(n) {
    this.setLighting(n);
    this.syncPanel?.();
  }

  status() {
    const st = this.sub.getStatus();
    const el = document.getElementById('status');
    if (el)
      el.textContent = JSON.stringify(
        {
          backend: this.backend,
          t: +(this.tMs / 1000).toFixed(2),
          lights: this.lightMeshes.filter((m) => m.lm.visible).length,
          ...st,
          items: st.items,
        },
        null,
        1
      ).slice(0, 3000);
  }

  buildPanel() {
    const panel = document.getElementById('panel');
    panel.innerHTML = '';
    const inputs = [];
    const h = (t) => {
      const e = document.createElement('h4');
      e.textContent = t;
      panel.appendChild(e);
    };
    const btn = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = fn;
      panel.appendChild(b);
      return b;
    };
    const slider = (obj, key, min, max, step, onSet) => {
      const l = document.createElement('label');
      const name = document.createElement('span');
      name.textContent = key;
      const inp = document.createElement('input');
      inp.type = 'range';
      inp.min = min;
      inp.max = max;
      inp.step = step;
      const out = document.createElement('span');
      const read = () => {
        inp.value = obj[key];
        out.textContent = Number(obj[key]).toFixed(2);
      };
      inp.oninput = () => {
        obj[key] = Number(inp.value);
        out.textContent = Number(inp.value).toFixed(2);
        onSet?.();
      };
      read();
      l.append(name, inp, out);
      panel.appendChild(l);
      inputs.push(read);
    };
    const color = (obj, key) => {
      const l = document.createElement('label');
      const name = document.createElement('span');
      name.textContent = key;
      const inp = document.createElement('input');
      inp.type = 'color';
      const read = () => (inp.value = obj[key]);
      inp.oninput = () => (obj[key] = inp.value);
      read();
      l.append(name, inp, document.createElement('span'));
      panel.appendChild(l);
      inputs.push(read);
    };
    const select = (obj, key, choices) => {
      const l = document.createElement('label');
      const name = document.createElement('span');
      name.textContent = key;
      const inp = document.createElement('select');
      for (const c of choices) {
        const o = document.createElement('option');
        o.value = o.textContent = c;
        inp.appendChild(o);
      }
      const read = () => (inp.value = obj[key]);
      inp.onchange = () => (obj[key] = inp.value);
      read();
      l.append(name, inp, document.createElement('span'));
      panel.appendChild(l);
      inputs.push(read);
    };

    h('Clock');
    btn('▶ play / pause', () => (this.playing = !this.playing));
    btn('reset', () => this.reset());
    btn('+1 s', () => this.advance(1));
    slider(this.lab, 'speed', 0, 3, 0.05);
    h('View');
    for (const v of Object.keys(VIEWS)) btn(v, () => this.view(v));
    h('Light');
    for (const v of Object.keys(LIGHTING)) btn(v, () => this.light(v));
    slider(this.lab, 'bloom', 0, 2, 0.05);
    slider(this.lab, 'exposure', 0.25, 4, 0.05);
    slider(this.lab, 'bloomThreshold', 0, 3, 0.05);
    slider(this.lab, 'lightGain', 0, 3, 0.05);
    slider(this.lab, 'glass', 0, 1, 0.05);
    slider(this.lab, 'tier', 0, 6, 1);
    h('Fluid (FLUID_PARAMS)');
    let cat = null;
    for (const [k, d] of Object.entries(FLUID_PARAMS)) {
      if (d.category !== cat) {
        cat = d.category;
        const e = document.createElement('div');
        e.style.color = '#888';
        e.textContent = '— ' + cat;
        panel.appendChild(e);
      }
      if (d.type === 'color') color(this.params, k);
      else if (d.type === 'enum') select(this.params, k, d.choices ?? d.options ?? []);
      else if (d.type === 'boolean') {
        slider(this.params, k, 0, 1, 1);
      } else slider(this.params, k, d.min ?? 0, d.max ?? 1, d.step ?? 0.01);
    }
    if (this.sub.triggerReaction) {
      h('Reactions');
      for (const kind of this.sub.reactionKinds?.() ?? []) btn(kind, () => this.sub.triggerReaction(kind, this.tMs));
    }
    this.syncPanel = () => inputs.forEach((f) => f());
  }

  loop() {
    let lastT = performance.now();
    const step = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastT) / 1000);
      lastT = now;
      if (!this.busy) {
        if (this.playing) this.tick(dt * this.lab.speed);
        this.render(true);
        if (this.frames % 30 === 0) this.status();
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

const lab = new FluidLab();
window.fluidLab = lab;
window.THREE = THREE;
lab.ready.then(
  () => {
    lab.loop();
    lab.playing = true;
  },
  (e) => {
    document.getElementById('status').textContent = 'FAILED: ' + (e && e.stack ? e.stack : e);
  }
);
