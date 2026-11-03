/**
 * SHADER LAB — THE STORYBOOK CLOUD BENCH (2026-11-03).
 *
 * Renders a REAL map's albedo as the board (with a felt "table" round it when the Table is on), the cloud
 * shadow on it, and either the shipped realistic tops (`cloud-shade.js#buildCloudTopsNode` over
 * `world/cloud-field.js`) or the storybook tops (`effects/clouds/storybook-clouds.js`), seen by the shared
 * scene eye (`scene/scene-eye.js`). Every pixel of cloud comes from the production modules; only the ground
 * lighting is a stand-in (albedo × a rough hour tint × the cloud transmittance — the real grade is not here,
 * so judge the clouds against each other and against the art, not absolute exposure).
 *
 * Map art is NOT in the repo (public): `runs/sb-art/<map>.jpg`, downscaled copies made locally.
 *
 * Same render path as `cloud-lab.js` (offscreen target, synchronous readPixels — rAF never fires in the
 * Browser pane, see that file's `readTile`).
 *
 * @module tools/shader-lab/storybook-cloud-lab
 */

import {
  cloudRecipeFor,
  createCloudUniforms,
  pushCloudUniforms,
  buildCloudFieldNode,
  buildCloudGroundVisNode,
  CLOUD_SHADOW_STREAK_SPREAD,
} from '../../src/world/cloud-field.js';
import { windFlowVector } from '../../src/world/wind-bake.js';
import { computeSun } from '../../src/world/sun.js';
import { createSkyHandle } from '../../src/effects/sky-access.js';
import {
  buildCloudTopsNode,
  buildCloudTopsParallaxWorldXY,
  cloudTopsEyeMagnification,
} from '../../src/effects/clouds/cloud-shade.js';
import { projectShadowOffset } from '../../src/effects/lighting/light-visibility.js';
import { sceneEyeHeight } from '../../src/scene/scene-eye.js';
import {
  createStorybookUniforms,
  pushStorybookUniforms,
  resolveStorybookDeck,
  storybookPalette,
  storybookLight,
  buildStorybookCloudNode,
  buildStorybookShadowNode,
} from '../../src/effects/clouds/storybook-clouds.js';

/** World size of each lab map (its real art's pixel size — 1 art px = 1 world px). */
export const LAB_MAPS = Object.freeze({
  wilderness: { w: 15000, h: 7500 },
  jhh: { w: 9750, h: 9750 },
  snow: { w: 8700, h: 7950 },
  docklands: { w: 6750, h: 6750 },
});

const lerp = (a, b, t) => a + (b - a) * t;

/** A rough stand-in for the grade: the hour's light on the ground. */
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

export class StorybookDriver {
  constructor({ THREE }) {
    this.THREE = THREE;
    const T = THREE.TSL;
    this.renderer = new THREE.WebGPURenderer({ antialias: false, alpha: false, forceWebGL: true });
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.scene = new THREE.Scene();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.cloudU = createCloudUniforms(T);
    this.sbU = createStorybookUniforms(T);
    this.u = {
      view: T.uniform(T.vec4(0, 0, 1, 1)),
      board: T.uniform(T.vec4(0, 0, 1, 1)),
      tableOn: T.uniform(T.float(1)),
      tint: T.uniform(T.vec3(1, 1, 1)),
      offset: T.uniform(T.vec2(0, 0)),
      fillShare: T.uniform(T.float(0.3)),
      blur: T.uniform(T.float(0.4)),
      shadowStrength: T.uniform(T.float(1.34)),
      eye: T.uniform(T.vec3(0, 0, 10000)),
      M: T.uniform(T.float(1)),
      sunDir: T.uniform(T.vec2(1, 0)),
      sinE: T.uniform(T.float(0.5)),
      cosE: T.uniform(T.float(0.87)),
      tanE: T.uniform(T.float(0.58)),
      keyRgb: T.uniform(T.vec3(1, 0.93, 0.84)),
      fillRgb: T.uniform(T.vec3(0.46, 0.63, 1)),
      topsOpacity: T.uniform(T.float(0.8)),
    };
    this.textures = new Map();
    this.materials = new Map();
    this.ready = this.renderer.init();
  }

  get backend() {
    return this.renderer?.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2';
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

  material(mode, tex, variant = 'both', groundKind = 'map') {
    const key = `${mode}:${variant}:${groundKind}:${tex.uuid}`;
    if (this.materials.has(key)) return this.materials.get(key);
    const THREE = this.THREE;
    const T = THREE.TSL;
    const { float, vec2, vec3, vec4, mix, uv, texture, step, clamp } = T;
    const u = this.u;
    const wx = mix(u.view.x, u.view.z, uv().x);
    const wy = mix(u.view.w, u.view.y, uv().y);
    const worldXY = vec2(wx, wy);
    const bw = u.board.z.sub(u.board.x);
    const bh = u.board.w.sub(u.board.y);
    const mapUv = vec2(wx.sub(u.board.x).div(bw), wy.sub(u.board.y).div(bh));
    const inBoard = step(float(0), mapUv.x)
      .mul(step(mapUv.x, float(1)))
      .mul(step(float(0), mapUv.y))
      .mul(step(mapUv.y, float(1)));
    const albedo = texture(tex, clamp(mapUv, 0, 1)).rgb;
    const felt = vec3(0.035, 0.075, 0.05);
    // 'sea': the reference photos' deep blue sea, so a frame can sit beside them (round 5, 2026-11-03).
    const sea = mix(
      vec3(0.012, 0.09, 0.26),
      vec3(0.03, 0.16, 0.42),
      T.mx_noise_float(worldXY.div(9000)).mul(0.5).add(0.5)
    );
    const ground = groundKind === 'sea' ? sea : mix(felt.mul(u.tableOn), albedo, inBoard);
    const wind = { drift: this.cloudU.drift, dir: this.cloudU.windDir };
    let vis;
    let tops;
    if (mode === 'storybook') {
      vis = buildStorybookShadowNode(T, {
        worldXY,
        u: this.sbU,
        wind,
        offset: u.offset,
        blur: u.blur,
        fillShare: u.fillShare,
      });
      tops = buildStorybookCloudNode(T, {
        groundXY: worldXY,
        u: this.sbU,
        wind,
        debug: variant === 'debug' ? 'occ' : null,
      });
    } else {
      vis = buildCloudGroundVisNode(T, {
        worldXY,
        uniforms: this.cloudU,
        buildField: buildCloudFieldNode,
        offset: u.offset,
        streakSpread: CLOUD_SHADOW_STREAK_SPREAD,
        fillShare: u.fillShare,
        blurFieldUnits: u.blur,
      });
      const pw = buildCloudTopsParallaxWorldXY(T, worldXY, vec2(u.eye.x, u.eye.y), u.M);
      const t = buildCloudTopsNode(T, {
        worldXY: pw,
        uniforms: this.cloudU,
        buildField: buildCloudFieldNode,
        sun: { dirXY: u.sunDir, sinElev: u.sinE, cosElev: u.cosE, tanElev: u.tanE },
        colors: { keyRgb: u.keyRgb, fillRgb: u.fillRgb },
      });
      tops = { rgb: t.rgb, alpha: t.alpha.mul(u.topsOpacity).mul(inBoard) };
    }
    // Shadow only on the board (the cache is clipped to the effects extent).
    const shadowVis = mix(
      float(1),
      mix(float(1), vis, u.shadowStrength).max(float(0)),
      groundKind === 'sea' ? float(1) : inBoard
    );
    // `variant` (compile timing): 'tops' / 'shadow' build only that half, as production's two separate materials.
    const lit = ground.mul(u.tint).mul(variant === 'tops' ? float(1) : shadowVis);
    const out = variant === 'shadow' ? lit : mix(lit, tops.rgb, clamp(tops.alpha, 0, 1));
    const mat = new THREE.MeshBasicNodeMaterial();
    // 'cov': the raw shadow transmittance (calibration: with fillShare 0 and a hard edge it is the coverage mask).
    mat.colorNode =
      variant === 'debug'
        ? vec4(tops.rgb, float(1))
        : variant === 'cov'
          ? vec4(vec3(vis, vis, vis), float(1))
          : vec4(out, float(1));
    this.materials.set(key, mat);
    return mat;
  }

  /**
   * Render one frame and return { bytes, w, h }.
   * @param {object} o
   */
  async render(o = {}) {
    const THREE = this.THREE;
    const map = o.map ?? 'wilderness';
    const dims = LAB_MAPS[map];
    const mode = o.mode ?? 'storybook';
    const hour = o.hour ?? 11;
    const cover = o.cover ?? 0.45;
    const type01 = o.type01 ?? 0.5;
    const tableOn = o.tableOn ?? true;
    const W = o.width ?? 1280;
    const aspect = o.aspect ?? 16 / 9;
    const H = Math.round(W / aspect);
    const board = { minX: 0, minY: 0, maxX: dims.w, maxY: dims.h };
    // View: the whole table by default (board + margin), optionally zoomed/panned.
    const zoom = o.zoom ?? 1;
    const spanX0 = Math.max(dims.w * 1.5, dims.h * 1.5 * aspect);
    const spanX = spanX0 / zoom;
    const spanY = spanX / aspect;
    const cx = dims.w / 2 + (o.panX ?? 0) * dims.w;
    const cy = dims.h / 2 + (o.panY ?? 0) * dims.h;
    const view = { minX: cx - spanX / 2, minY: cy - spanY / 2, maxX: cx + spanX / 2, maxY: cy + spanY / 2 };
    const eyeH = sceneEyeHeight(spanY / 2);
    const tex = await this.texture(map);
    const u = this.u;
    u.view.value.set(view.minX, view.minY, view.maxX, view.maxY);
    u.board.value.set(0, 0, dims.w, dims.h);
    u.tableOn.value = tableOn ? 1 : 0;
    u.eye.value.set(cx, cy, eyeH);
    const sun = computeSun(hour);
    u.tint.value.set(...groundTint(sun));
    const windDeg = o.windDeg ?? 70;
    const recipe = cloudRecipeFor(type01);
    const flow = windFlowVector(windDeg + recipe.shearDeg);
    const scalePx = (o.scalePx ?? 1100) * 2;
    const drift = o.drift ?? { x: 0, y: 0 };
    pushCloudUniforms(this.cloudU, {
      recipe,
      cover01: Math.min(cover, 0.3),
      scalePx,
      drift,
      boil: o.boil ?? 0,
      windDir: flow,
    });
    const capped = createSkyHandle({ sun, weather: { cloudCover01: Math.min(cover, 0.3) }, realism01: 0 });
    const tot = capped.key.strength + capped.fill.strength;
    u.fillShare.value = tot > 1e-6 ? capped.fill.strength / tot : 1;
    const sky = createSkyHandle({ sun, weather: { cloudCover01: cover }, realism01: 0 });
    const off = projectShadowOffset({
      azimuthDeg: sky.key.azimuthDeg,
      elevationDeg: sky.key.elevationDeg,
      heightPx: o.altitudePx ?? 1400,
      maxOffsetPx: 9000,
      offsetScale: 1,
      softKnee: true,
    });
    u.offset.value.set(off.x, off.y);
    u.blur.value = o.blur ?? 0.4;
    u.shadowStrength.value = o.shadowStrength ?? 1.34;
    const e = (sky.key.elevationDeg * Math.PI) / 180;
    u.sunDir.value.set(sky.key.dirX, sky.key.dirY);
    u.sinE.value = Math.sin(e);
    u.cosE.value = Math.cos(e);
    u.tanE.value = Math.max(0.02, Math.tan(e));
    const ks = sky.key.strength;
    const fs = sky.fill.strength;
    u.keyRgb.value.set(sky.key.colorRgb[0] * ks, sky.key.colorRgb[1] * ks, sky.key.colorRgb[2] * ks);
    u.fillRgb.value.set(sky.fill.colorRgb[0] * fs, sky.fill.colorRgb[1] * fs, sky.fill.colorRgb[2] * fs);
    u.M.value = cloudTopsEyeMagnification(o.altitudePx ?? 1400, eyeH);
    u.topsOpacity.value = 0.8;
    const deck = resolveStorybookDeck({
      cover01: cover,
      scalePx: o.scalePx ?? 1100,
      anisotropy: recipe.anisotropy,
      board,
      tableOn,
      eyeHeight: eyeH,
      params: o.params ?? {},
    });
    pushStorybookUniforms(this.sbU, {
      deck,
      palette: storybookPalette(sun, { cover01: cover, precip01: o.precip ?? 0 }),
      light: storybookLight({ x: sky.key.dirX, y: sky.key.dirY }, sky.key.elevationDeg),
      eye: { x: cx, y: cy, height: eyeH },
      board,
      footprintPx: spanX / W,
      timeSec: o.time ?? 0,
      evolve: o.evolve ?? 1,
    });
    const calThr = o.variant !== 'cov' && deck.fill > 0 ? this.thrFor(deck.fill) : null;
    if (Number.isFinite(o.threshold)) this.sbU.field.value.x = o.threshold;
    else if (calThr !== null) this.sbU.field.value.x = calThr;
    if (o.variant === 'cov') {
      u.fillShare.value = 0;
      u.blur.value = 0.001;
      u.offset.value.set(0, 0);
      this.sbU.domain2.value.z = 1;
    }
    this.sbU.opacity.value = o.opacity ?? 1;
    this.quad.material = this.material(mode, tex, o.variant ?? 'both', o.ground ?? 'map');
    if (!this._rt || this._rt.width !== W || this._rt.height !== H) {
      this._rt?.dispose();
      this._rt = new THREE.RenderTarget(W, H, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat });
      this._rt.texture.colorSpace = THREE.SRGBColorSpace;
    }
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this._rt);
    const t0 = performance.now();
    this.renderer.render(this.scene, this.camera);
    this.renderer.render(this.scene, this.camera);
    const bytes = new Uint8Array(W * H * 4);
    const gl = this.renderer.backend.gl;
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    const ms = performance.now() - t0;
    this.renderer.setRenderTarget(prev);
    return { bytes, w: W, h: H, ms, deck, eyeH };
  }

  /**
   * Measure the field's coverage at a ladder of thresholds (the hard-edged shadow mask, wide view, 3 places) —
   * the data behind `STORYBOOK_CORE_QUANTILES`. Afterwards `render` uses it for every frame's threshold, so a
   * field change can be judged at the right coverage before the module's table is updated.
   */
  async calibrate() {
    const ths = [-0.8, -0.6, -0.4, -0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2];
    const out = [];
    for (const th of ths) {
      let cov = 0;
      let n = 0;
      for (const [px, py] of [
        [0, 0],
        [7, 3],
        [-11, 5],
      ]) {
        const r = await this.render({
          variant: 'cov',
          ground: 'sea',
          cover: 0.5,
          zoom: 0.25,
          panX: px,
          panY: py,
          threshold: th,
          width: 480,
          evolve: 0,
        });
        for (let i = 0; i < r.bytes.length; i += 4) {
          n++;
          if (r.bytes[i] < 128) cov++;
        }
      }
      out.push([th, +(cov / n).toFixed(4)]);
    }
    this.calTable = out;
    return out;
  }

  /** The calibrated threshold for a coverage fraction (null before `calibrate`). */
  thrFor(fill) {
    const t = this.calTable;
    if (!t) return null;
    for (let i = 0; i < t.length - 1; i++) {
      const [a, fa] = t[i];
      const [b, fb] = t[i + 1];
      if (fill <= fa && fill >= fb) return a + ((b - a) * (fa - fill)) / Math.max(1e-6, fa - fb);
    }
    return fill > t[0][1] ? t[0][0] : t[t.length - 1][0];
  }

  /** Render and POST a PNG to runs/<run>/<file>. */
  async shot(run, file, o = {}) {
    const r = await this.render(o);
    const canvas = document.createElement('canvas');
    canvas.width = r.w;
    canvas.height = r.h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(r.w, r.h);
    for (let y = 0; y < r.h; y++) {
      const src = (r.h - 1 - y) * r.w * 4;
      img.data.set(r.bytes.subarray(src, src + r.w * 4), y * r.w * 4);
    }
    ctx.putImageData(img, 0, 0);
    if (o.label) {
      ctx.font = '600 22px ui-monospace, monospace';
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, 0, ctx.measureText(o.label).width + 20, 34);
      ctx.fillStyle = '#fff';
      ctx.fillText(o.label, 10, 24);
    }
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    const resp = await fetch(`/__lab/artifact?run=${encodeURIComponent(run)}&file=${encodeURIComponent(file)}`, {
      method: 'POST',
      body: blob,
    });
    return { ok: resp.ok, ms: r.ms, deck: r.deck, eyeH: r.eyeH };
  }
}
