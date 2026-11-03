/**
 * SHADER LAB — RAIN UNDER THE CLOUDS (2026-11-03).
 *
 * The production storybook clouds (`effects/clouds/storybook-clouds.js`) and the production precipitation
 * engines (`effects/particles/precip-runtime.js` + `precip-splash-runtime.js`) on ONE WebGPU canvas, seen by the
 * shared scene eye, over a real map's albedo. Built to judge how rain/snow relate to the clouds they fall from:
 * where a drop is born, how it falls in perspective, how wind carries it, where it lands and splashes.
 *
 * Three instruments:
 *   - `shot(run, file, o)`      one composited frame (ground + cloud shadow, splashes, the fall, cloud tops).
 *   - `exposure(run, file, o)`  a LONG EXPOSURE of the fall alone: many frames of bodies drawn without clearing,
 *                               so every drop's whole path from birth to landing shows as one trail.
 *   - `stats(o)`                reads the fall's GPU buffers twice, a known dt apart, and reports per-body motion
 *                               in real units (m/s at the scene's px/m): horizontal speed vs the wind, fall
 *                               speed, the lean angle a body draws at, life, birth height against the cloud deck.
 *
 * Only the ground lighting is a stand-in (albedo x a rough hour tint x the cloud shadow), like
 * `storybook-cloud-lab.js`. Map art is not in the repo: `runs/sb-art/<map>.jpg`.
 *
 * Time never comes from rAF (the Browser pane may be hidden): every frame is stepped by hand at a fixed dt.
 *
 * @module tools/shader-lab/rain-cloud-lab
 */

import { cloudRecipeFor, createCloudUniforms, pushCloudUniforms, cloudDriftStep } from '../../src/world/cloud-field.js';
import { windFlowVector } from '../../src/world/wind-bake.js';
import {
  WIND_DEFAULT_PIXELS_PER_METRE,
  WIND_DIAL_MAX_METRES_PER_SECOND,
  createWindAdvectionState,
  stepWindAdvection,
} from '../../src/world/index.js';
import { computeSun } from '../../src/world/sun.js';
import { createSkyHandle } from '../../src/effects/sky-access.js';
import { projectShadowOffset } from '../../src/effects/lighting/light-visibility.js';
import { resolveSceneEye } from '../../src/scene/scene-eye.js';
import {
  createStorybookUniforms,
  pushStorybookUniforms,
  resolveStorybookDeck,
  storybookPalette,
  storybookLight,
  buildStorybookCloudNode,
  buildStorybookShadowNode,
} from '../../src/effects/clouds/storybook-clouds.js';
import * as storybook from '../../src/effects/clouds/storybook-clouds.js';
import { createPrecipEngine } from '../../src/effects/particles/precip-runtime.js';
import { createPrecipSplashEngine } from '../../src/effects/particles/precip-splash-runtime.js';
import { PRECIP_SPECIES, resolveSpeciesFrame } from '../../src/effects/precipitation/precip-species.js';
import { PRECIPITATION_PARAMS } from '../../src/effects/precipitation/precipitation.js';
import * as cloudRain from '../../src/effects/precipitation/cloud-rain.js';
import { LAB_MAPS } from './storybook-cloud-lab.js';

export { LAB_MAPS };

const lerp = (a, b, t) => a + (b - a) * t;

/** The Precipitation card's shipped defaults — what a scene with no overrides runs. */
export const PRECIP_DEFAULTS = Object.freeze(
  Object.fromEntries(Object.entries(PRECIPITATION_PARAMS).map(([k, v]) => [k, v.default]))
);

/** A rough stand-in for the grade: the hour's light on the ground (same table as the storybook lab). */
function groundTint(sun) {
  const e = sun.elevationDeg;
  const keys = [
    [-18, [0.16, 0.2, 0.34]],
    [-8, [0.32, 0.36, 0.56]],
    [-2, [0.62, 0.48, 0.58]],
    [3, [1.0, 0.78, 0.6]],
    [12, [1.0, 0.95, 0.88]],
    [30, [1.0, 1.0, 1.0]],
  ];
  let i = 0;
  while (i < keys.length - 2 && e > keys[i + 1][0]) i++;
  const t = Math.max(0, Math.min(1, (e - keys[i][0]) / (keys[i + 1][0] - keys[i][0])));
  return keys[i][1].map((v, k) => lerp(v, keys[i + 1][1][k], t));
}

export class RainCloudDriver {
  constructor({ THREE }) {
    this.THREE = THREE;
    const T = THREE.TSL;
    this.renderer = new THREE.WebGPURenderer({ antialias: false, alpha: false });
    this.cloudU = createCloudUniforms(T);
    this.sbU = createStorybookUniforms(T);
    this.wind = { drift: this.cloudU.drift, dir: this.cloudU.windDir };
    this.u = {
      board: T.uniform(T.vec4(0, 0, 1, 1)),
      tableOn: T.uniform(T.float(1)),
      tint: T.uniform(T.vec3(1, 1, 1)),
      offset: T.uniform(T.vec2(0, 0)),
      fillShare: T.uniform(T.float(0.3)),
      blur: T.uniform(T.float(0.4)),
      shadowStrength: T.uniform(T.float(1.34)),
      topsOpacity: T.uniform(T.float(1)),
      /** 0..1 — the ground darkened for the long exposure, so trails read. */
      groundDim: T.uniform(T.float(1)),
      fieldOverlay: T.uniform(T.float(0)),
    };
    // The shared wind door, as the production handle shapes it.
    this.windHandle = {
      ambient: {
        speed01: T.uniform(T.float(0)),
        directionDeg: T.uniform(T.float(0)),
        gustiness01: T.uniform(T.float(1)),
        pixelsPerMetre: T.uniform(T.float(WIND_DEFAULT_PIXELS_PER_METRE)),
        advection: createWindAdvectionState(),
      },
    };
    this.engines = new Map();
    this.splashes = new Map();
    this.textures = new Map();
    this.nowMs = 0;
    this.cloudDrift = { x: 0, y: 0 };
    this.state = null;
    this.ready = this.init();
  }

  get backend() {
    return this.renderer?.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2';
  }

  async init() {
    const THREE = this.THREE;
    await this.renderer.init();
    this.camera = new THREE.OrthographicCamera(0, 1, 0, 1, 0.1, 1000);
    this.camera.position.set(0, 0, 100);
    const open = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
    open.needsUpdate = true;
    this.openSky = open;
    this.groundScene = new THREE.Scene();
    this.topsScene = new THREE.Scene();
    const plane = new THREE.PlaneGeometry(1, 1);
    this.groundMesh = new THREE.Mesh(plane, null);
    this.topsMesh = new THREE.Mesh(plane, null);
    for (const m of [this.groundMesh, this.topsMesh]) m.frustumCulled = false;
    this.groundScene.add(this.groundMesh);
    this.topsScene.add(this.topsMesh);
    // The rain field (cloud-rain.js) — the viewer's own small target, rendered the same way.
    if (cloudRain.buildStorybookRainFieldNode) {
      this.rainRT = new THREE.RenderTarget(256, 144, { type: THREE.HalfFloatType, depthBuffer: false });
      this.rainRT.texture.minFilter = THREE.LinearFilter;
      this.rainRT.texture.magFilter = THREE.LinearFilter;
      this.rainScene = new THREE.Scene();
      this.rainQuadMesh = new THREE.Mesh(plane, null);
      this.rainQuadMesh.frustumCulled = false;
      this.rainScene.add(this.rainQuadMesh);
      this.rainRect = THREE.TSL.uniform(THREE.TSL.vec4(0, 0, 1, 1));
    }
  }

  async texture(map) {
    if (this.textures.has(map)) return this.textures.get(map);
    const THREE = this.THREE;
    const tex = await new THREE.TextureLoader().loadAsync(`/tools/shader-lab/runs/sb-art/${map}.jpg`);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;
    this.textures.set(map, tex);
    return tex;
  }

  groundMaterial(tex) {
    const key = `ground:${tex.uuid}`;
    if (this[key]) return this[key];
    const THREE = this.THREE;
    const T = THREE.TSL;
    const { float, vec2, vec3, vec4, mix, texture, step, clamp, positionWorld } = T;
    const u = this.u;
    const worldXY = positionWorld.xy;
    const bw = u.board.z.sub(u.board.x);
    const bh = u.board.w.sub(u.board.y);
    const mapUv = vec2(worldXY.x.sub(u.board.x).div(bw), worldXY.y.sub(u.board.y).div(bh));
    const inBoard = step(float(0), mapUv.x)
      .mul(step(mapUv.x, float(1)))
      .mul(step(float(0), mapUv.y))
      .mul(step(mapUv.y, float(1)));
    const albedo = texture(tex, clamp(mapUv, 0, 1)).rgb;
    const felt = vec3(0.035, 0.075, 0.05);
    const ground = mix(felt.mul(u.tableOn), albedo, inBoard);
    const vis = buildStorybookShadowNode(T, {
      worldXY,
      u: this.sbU,
      wind: this.wind,
      offset: u.offset,
      blur: u.blur,
      fillShare: u.fillShare,
    });
    const shadowVis = mix(float(1), mix(float(1), vis, u.shadowStrength).max(float(0)), inBoard);
    // Debug: the rain field, read the way the engines read it (cloud-rain.js#sampleCloudRainNode), as a blue tint.
    let lit = ground.mul(u.tint).mul(shadowVis).mul(u.groundDim);
    if (this.rainRT) {
      const f = cloudRain.sampleCloudRainNode(T, { texNode: T.texture(this.rainRT.texture), rect: this.rainRect, worldXY });
      lit = mix(lit, vec3(0.1, 0.35, 1.0), f.mul(u.fieldOverlay).mul(0.55));
    }
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.colorNode = vec4(lit, float(1));
    mat.side = THREE.DoubleSide;
    mat.depthTest = false;
    mat.depthWrite = false;
    this[key] = mat;
    return mat;
  }

  topsMaterial() {
    if (this._tops) return this._tops;
    const THREE = this.THREE;
    const T = THREE.TSL;
    const t = buildStorybookCloudNode(T, { groundXY: T.positionWorld.xy, u: this.sbU, wind: this.wind });
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.colorNode = T.vec4(t.rgb, T.clamp(t.alpha, 0, 1).mul(this.u.topsOpacity));
    mat.transparent = true;
    mat.blending = THREE.NormalBlending;
    mat.side = THREE.DoubleSide;
    mat.depthTest = false;
    mat.depthWrite = false;
    this._tops = mat;
    return mat;
  }

  rainFieldMaterial() {
    if (this._rainMat) return this._rainMat;
    const THREE = this.THREE;
    const T = THREE.TSL;
    // The viewer's cloud-shadow-cache pattern: world = mix(rect.min, rect.max, uv()) on a QuadMesh, so the texel a
    // consumer reads with uv = (p - min) / size is the one written for p, whatever the camera convention.
    const mat = new THREE.NodeMaterial();
    const r = this.rainRect;
    const worldXY = T.vec2(T.mix(r.x, r.z, T.uv().x), T.mix(r.y, r.w, T.uv().y));
    const node = cloudRain.buildStorybookRainFieldNode(T, { worldXY, u: this.sbU, wind: this.wind });
    mat.fragmentNode = T.vec4(node, node, node, T.float(1));
    mat.depthTest = false;
    mat.depthWrite = false;
    this._rainMat = mat;
    this._rainQuad = new THREE.QuadMesh(mat);
    return mat;
  }

  engine(id) {
    if (this.engines.has(id)) return this.engines.get(id);
    const THREE = this.THREE;
    // The production order: the fed splash engine first, its sink built into the fall's kernel.
    const s = createPrecipSplashEngine({
      THREE,
      speciesId: id,
      windHandle: this.windHandle,
      renderOrder: 9,
      openSkyTexture: this.openSky,
      fed: true,
    });
    if (s.ok) s.init(this.renderer);
    const e = createPrecipEngine({
      THREE,
      speciesId: id,
      windHandle: this.windHandle,
      renderOrder: 10,
      openSkyTexture: this.openSky,
      pxPerMeter: WIND_DEFAULT_PIXELS_PER_METRE,
      splashSink: s.sink ?? null,
    });
    e.init(this.renderer);
    this.engines.set(id, e);
    this.splashes.set(id, s);
    return e;
  }

  /**
   * Set the whole scene for the next frames. Everything not given keeps the shipped default.
   * @param {object} o
   */
  configure(o = {}) {
    const THREE = this.THREE;
    const map = o.map ?? 'wilderness';
    const dims = LAB_MAPS[map];
    const W = o.width ?? 1280;
    const aspect = o.aspect ?? 16 / 9;
    const H = Math.round(W / aspect);
    const board = { minX: 0, minY: 0, maxX: dims.w, maxY: dims.h };
    // View: `spanX` world px wide (default 2000 = the runtime's reference view, about one Foundry screen at zoom 1).
    const spanX = o.spanX ?? 2000;
    const spanY = spanX / aspect;
    const cx = (o.cx ?? 0.5) * dims.w;
    const cy = (o.cy ?? 0.5) * dims.h;
    const view = { minX: cx - spanX / 2, minY: cy - spanY / 2, maxX: cx + spanX / 2, maxY: cy + spanY / 2 };
    const eye = resolveSceneEye(view, o.fovDeg ?? 45);
    const hour = o.hour ?? 11;
    const cover = o.cover ?? 0.5;
    const precip = o.precip ?? 0.6;
    const windSpeed01 = o.wind ?? 0.15;
    const windDeg = o.windDeg ?? 70;
    const species = o.species ?? 'rain';
    // Every configure starts the same sky at the same moment (`o.timeSec`), so shots compare.
    if (!o.keepTime) {
      this.nowMs = (o.timeSec ?? 0) * 1000;
      this.cloudDrift = { x: 0, y: 0 };
    }
    this.state = {
      ...o,
      map,
      dims,
      W,
      H,
      board,
      view,
      eye,
      hour,
      cover,
      precip,
      windSpeed01,
      windDeg,
      species,
      tops: o.tops ?? spanX >= 6000,
    };
    const u = this.u;
    u.board.value.set(0, 0, dims.w, dims.h);
    u.tableOn.value = 1;
    u.fieldOverlay.value = o.fieldOverlay ? 1 : 0;
    u.topsOpacity.value = Number.isFinite(o.topsOpacity) ? o.topsOpacity : 1;
    const sun = computeSun(hour);
    this.sun = sun;
    u.tint.value.set(...groundTint(sun));
    const recipe = cloudRecipeFor(o.type01 ?? 0.5);
    this.recipe = recipe;
    const flow = windFlowVector(windDeg + recipe.shearDeg);
    this.flow = flow;
    pushCloudUniforms(this.cloudU, {
      recipe,
      cover01: Math.min(cover, 0.3),
      scalePx: 2200,
      drift: this.cloudDrift,
      boil: 0,
      windDir: flow,
    });
    const capped = createSkyHandle({ sun, weather: { cloudCover01: Math.min(cover, 0.3) }, realism01: 0 });
    const tot = capped.key.strength + capped.fill.strength;
    u.fillShare.value = tot > 1e-6 ? capped.fill.strength / tot : 1;
    const sky = createSkyHandle({ sun, weather: { cloudCover01: cover }, realism01: 0 });
    this.sky = sky;
    const off = projectShadowOffset({
      azimuthDeg: sky.key.azimuthDeg,
      elevationDeg: sky.key.elevationDeg,
      heightPx: 1400,
      maxOffsetPx: 9000,
      offsetScale: 1,
      softKnee: true,
    });
    u.offset.value.set(off.x, off.y);
    this.deck = resolveStorybookDeck({
      cover01: cover,
      scalePx: 1100,
      anisotropy: recipe.anisotropy,
      board,
      tableOn: true,
      eyeHeight: eye.height,
      params: o.cloudParams ?? {},
    });
    this.pushClouds(0);
    // The wind door.
    const a = this.windHandle.ambient;
    a.speed01.value = windSpeed01;
    a.directionDeg.value = windDeg;
    a.gustiness01.value = o.gustiness ?? 1;
    // Engines: only the active species shows.
    for (const [id, e] of this.engines) {
      if (id !== species) e.setFrame({ liveCount: 0 });
      const s = this.splashes.get(id);
      if (id !== species && s?.ok) s.setFrame({ liveCount: 0, splashRate01: 0 });
    }
    const e = this.engine(species);
    const row = PRECIP_SPECIES[species];
    this.frame = resolveSpeciesFrame(row, {
      precip01: precip,
      stormActivity01: o.storm ?? 0,
      dayFactor01: Math.max(0, Math.min(1, sky.key.strength + 0.3)),
      flash01: 0,
      sceneLight01: 1,
    });
    this.tuning = { ...PRECIP_DEFAULTS, ...(o.tuning ?? {}) };
    e.setTuning(this.tuning);
    const s = this.splashes.get(species);
    if (s?.ok) s.setTuning(this.tuning);
    if (!this._rt || this._rt.width !== W || this._rt.height !== H) {
      this._rt?.dispose();
      this._rt = new THREE.RenderTarget(W, H, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat });
      this._rt.texture.colorSpace = THREE.SRGBColorSpace;
    }
    const cam = this.camera;
    cam.left = view.minX;
    cam.right = view.maxX;
    cam.top = view.minY;
    cam.bottom = view.maxY;
    cam.updateProjectionMatrix();
    for (const m of [this.groundMesh, this.topsMesh, this.rainQuadMesh].filter(Boolean)) {
      m.position.set(cx, cy, 0);
      m.scale.set(spanX * 1.02, spanY * 1.02, 1);
    }
    return { view, eye, deck: this.deck, frame: this.frame };
  }

  pushClouds(timeSec) {
    const st = this.state;
    pushCloudUniforms(this.cloudU, {
      recipe: this.recipe,
      cover01: Math.min(st.cover, 0.3),
      scalePx: 2200,
      drift: this.cloudDrift,
      boil: 0,
      windDir: this.flow,
    });
    pushStorybookUniforms(this.sbU, {
      deck: this.deck,
      palette: storybookPalette(this.sun, { cover01: st.cover, precip01: st.precip }),
      light: storybookLight({ x: this.sky.key.dirX, y: this.sky.key.dirY }, this.sky.key.elevationDeg),
      eye: st.eye,
      board: st.board,
      footprintPx: (st.view.maxX - st.view.minX) / st.W,
      timeSec,
      evolve: st.evolve ?? 1,
    });
    this.sbU.opacity.value = 1;
  }

  /** Step `n` frames of `dtMs` each: cloud drift, wind advection, the fall and the splashes. */
  advance(n = 1, dtMs = 1000 / 60) {
    const st = this.state;
    const e = this.engine(st.species);
    const s = this.splashes.get(st.species);
    const ppm = WIND_DEFAULT_PIXELS_PER_METRE;
    for (let k = 0; k < n; k++) {
      const dt = dtMs / 1000;
      this.nowMs += dtMs;
      // Cloud drift: the viewer's rule (cloudDriftMetresPerSecond is the old dial curve capped at 34.8 m/s;
      // the lab uses the linear 70 m/s dial capped the same way) x the shipped speedMul 0.25.
      const cloudMps = Math.max(2, Math.min(34.8, st.windSpeed01 * WIND_DIAL_MAX_METRES_PER_SECOND));
      const step = cloudDriftStep({
        dtSec: dt,
        windDirX: this.flow.x,
        windDirY: this.flow.y,
        windSpeedPxPerSec: cloudMps * ppm * (st.cloudSpeedMul ?? 0.25),
        scalePx: 2200,
        recipe: this.recipe,
      });
      this.cloudDrift.x += step.dx;
      this.cloudDrift.y += step.dy;
      this.cloudVelPxS = { x: step.dx / dt, y: step.dy / dt };
      this.pushClouds(this.nowMs / 1000);
      stepWindAdvection(this.windHandle.ambient.advection, {
        tMs: this.nowMs,
        dtSec: dt,
        speed01: st.windSpeed01,
        directionDeg: st.windDeg,
      });
      this.renderRainField();
      e.setWorldRect(st.view);
      e.setViewRect(st.view);
      e.setEye(st.eye);
      e.setSceneBounds(st.board);
      if (e.setCloudDeck) e.setCloudDeck(this.cloudDeckFor());
      e.setFrame(this.frame);
      e.step(this.renderer, dt, this.nowMs, this.windHandle);
      if (s?.ok) {
        s.setWorldRect(st.view);
        s.setSceneBounds(st.board);
        if (s.setCloudDeck) {
          const cd = this.cloudDeckFor();
          s.setCloudDeck(cd ? { ...cd, landingShiftPx: e.landingShiftPx?.() } : null);
        }
        s.setFrame(this.frame);
        s.step(this.renderer, dt, this.nowMs, this.windHandle);
      }
    }
  }

  /** What the viewer hands the engines about the clouds this frame (null on the baseline code). */
  cloudDeckFor() {
    if (!this.rainRT || st0(this.state)) return null;
    return {
      deck: this.deck,
      eye: this.state.eye,
      texture: this.rainRT.texture,
      rect: this.rainFieldRect(),
      linkWeight: cloudRain.cloudRainLinkWeight(this.deck.fill, this.state.link ?? 1),
      cloudVelPxS: this.cloudVelPxS ?? { x: 0, y: 0 },
    };
  }

  /** The view padded by the fall's own spawn margin (25%), so every birthplace has field under it. */
  rainFieldRect() {
    const v = this.state.view;
    const mx = (v.maxX - v.minX) * 0.25;
    const my = (v.maxY - v.minY) * 0.25;
    return { minX: v.minX - mx, minY: v.minY - my, maxX: v.maxX + mx, maxY: v.maxY + my };
  }

  renderRainField() {
    if (!this.rainRT) return;
    const r = this.rainFieldRect();
    this.rainRect.value.set(r.minX, r.minY, r.maxX, r.maxY);
    this.rainFieldMaterial();
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.rainRT);
    this._rainQuad.render(this.renderer);
    this.renderer.setRenderTarget(prev);
  }

  /** Composite one frame into the lab target and read it back. */
  async frameBytes({ exposureFrames = 0, dtMs = 1000 / 60, layers = 'all' } = {}) {
    const st = this.state;
    const r = this.renderer;
    const tex = await this.texture(st.map);
    this.groundMesh.material = this.groundMaterial(tex);
    this.topsMesh.material = this.topsMaterial();
    const prev = r.getRenderTarget();
    const prevAuto = r.autoClear;
    r.setRenderTarget(this._rt);
    r.autoClear = false;
    r.setClearColor(0x000000, 1);
    r.clear();
    this.u.groundDim.value = exposureFrames > 0 ? 0.28 : 1;
    if (layers !== 'fall') r.render(this.groundScene, this.camera);
    const e = this.engine(st.species);
    const s = this.splashes.get(st.species);
    const drawFall = () => {
      if (s?.ok && layers !== 'fall') r.render(s.scene, this.camera);
      if (layers !== 'ground') r.render(e.scene, this.camera);
    };
    if (exposureFrames > 0) {
      // Long exposure: step and draw without clearing.
      for (let k = 0; k < exposureFrames; k++) {
        this.advance(1, dtMs);
        r.setRenderTarget(this._rt);
        r.render(e.scene, this.camera);
      }
    } else {
      if (st.tops && st.rainUnderTops) {
        drawFall();
        r.render(this.topsScene, this.camera);
      } else {
        if (st.tops) r.render(this.topsScene, this.camera);
        drawFall();
      }
    }
    const bytes = await r.readRenderTargetPixelsAsync(this._rt, 0, 0, st.W, st.H);
    r.setRenderTarget(prev);
    r.autoClear = prevAuto;
    return { bytes, w: st.W, h: st.H };
  }

  /** Write RGBA bytes (top row first) as a PNG into runs/<run>/<file>. */
  async savePng(run, file, { bytes, w, h }, label) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    img.data.set(bytes.subarray(0, w * h * 4));
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    ctx.putImageData(img, 0, 0);
    if (label) {
      ctx.font = '600 20px ui-monospace, monospace';
      const lines = String(label).split('\n');
      const lw = Math.max(...lines.map((l) => ctx.measureText(l).width));
      ctx.fillStyle = 'rgba(0,0,0,0.62)';
      ctx.fillRect(0, 0, lw + 20, 12 + lines.length * 24);
      ctx.fillStyle = '#fff';
      lines.forEach((l, i) => ctx.fillText(l, 10, 26 + i * 24));
    }
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    const resp = await fetch(`/__lab/artifact?run=${encodeURIComponent(run)}&file=${encodeURIComponent(file)}`, {
      method: 'POST',
      body: blob,
    });
    return resp.ok;
  }

  /** Configure, warm `warmFrames`, then shoot one composited frame. */
  async shot(run, file, o = {}) {
    this.configure(o);
    this.advance(o.warmFrames ?? 120);
    const f = await this.frameBytes({ layers: o.layers ?? 'all' });
    return this.savePng(run, file, f, o.label);
  }

  /** Configure, warm, then a long exposure of the fall over `frames` frames. */
  async exposure(run, file, o = {}) {
    this.configure(o);
    this.advance(o.warmFrames ?? 120);
    const f = await this.frameBytes({ exposureFrames: o.frames ?? 24, dtMs: o.dtMs ?? 1000 / 60 });
    return this.savePng(run, file, f, o.label);
  }

  /**
   * Per-body motion in real units. Reads position/velocity/custom twice, `dtMs` apart (one hand-stepped frame),
   * for the live slots of the active species.
   */
  async stats(o = {}) {
    if (o.configure !== false) this.configure(o);
    this.advance(o.warmFrames ?? 120);
    const st = this.state;
    const e = this.engine(st.species);
    const b = e.labBuffers;
    if (!b) return { error: 'engine has no labBuffers' };
    const read = async (node) => new Float32Array(await this.renderer.getArrayBufferAsync(node.value));
    const [p0, c0] = await Promise.all([read(b.position), read(b.custom)]);
    const dtMs = o.dtMs ?? 1000 / 60;
    this.advance(1, dtMs);
    const [p1, v1, c1] = await Promise.all([read(b.position), read(b.velocity), read(b.custom)]);
    const ppm = WIND_DEFAULT_PIXELS_PER_METRE;
    const live = Math.min(e.capacity, Math.round(this.frame.liveCount ?? e.capacity));
    const dt = dtMs / 1000;
    const hs = [];
    const fs = [];
    const tilts = [];
    const birthH = [];
    const heights = [];
    for (let i = 0; i < live; i++) {
      const h0 = c0[i * 4 + 3];
      const h1 = c1[i * 4 + 3];
      if (!(h1 < h0) || h0 - h1 > 5000 * dt) continue; // respawned between the reads, or not falling
      const dx = p1[i * 2] - p0[i * 2];
      const dy = p1[i * 2 + 1] - p0[i * 2 + 1];
      const hSpd = Math.hypot(dx, dy) / dt / ppm;
      const fSpd = (h0 - h1) / dt / ppm;
      hs.push(hSpd);
      fs.push(fSpd);
      tilts.push((Math.atan2(hSpd, fSpd) * 180) / Math.PI);
      heights.push(h1);
      void v1;
    }
    for (let i = 0; i < live; i++) birthH.push(c1[i * 4 + 3]);
    const q = (arr, f) => {
      if (!arr.length) return null;
      const s = [...arr].sort((a, b2) => a - b2);
      return +s[Math.min(s.length - 1, Math.floor(f * s.length))].toFixed(2);
    };
    const summ = (arr) => ({ p10: q(arr, 0.1), p50: q(arr, 0.5), p90: q(arr, 0.9) });
    const windMps = st.windSpeed01 * WIND_DIAL_MAX_METRES_PER_SECOND;
    return {
      species: st.species,
      windMps: +windMps.toFixed(1),
      sampled: hs.length,
      horizontalMps: summ(hs),
      fallMps: summ(fs),
      leanDeg: summ(tilts),
      heightPx: summ(heights),
      lifeSec: fs.length ? +((q(heights, 0.5) ?? 0) / ppm / (q(fs, 0.5) || 1)).toFixed(2) : null,
      eyeH: Math.round(st.eye.height),
      deckBasePx: Math.round(this.deck.baseHeight),
      deckDomePx: Math.round(this.deck.domeHeight),
      tuning: e.debugState().tuning,
    };
  }
}

/** True when the lab should hand the engines no cloud information (`state.noClouds`). */
function st0(state) {
  return !!state?.noClouds;
}

void storybook;
