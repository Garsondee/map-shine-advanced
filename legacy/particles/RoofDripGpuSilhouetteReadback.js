/**
 * GPU roof-drip spawn extraction: renders the same screen-space roof alpha used for masking
 * into a downscaled RT with per-pixel Sobel-style normals, readPixels once, then CPU
 * exterior flood (silhouette-only). Spawn sites: **4-connected opaque components**, then
 * per-component polar stride (fair coverage across disjoint roofs) plus optional **inner
 * 1px ring** (double erosion) to reduce alpha-fringe clumping.
 * Screen→world uses the best of four NDC/V-flip modes probed on the halo samples.
 *
 * @module particles/RoofDripGpuSilhouetteReadback
 */

import { createLogger } from '../core/log.js';
import {
  labelOpaqueComponents4,
  componentOpaqueCentroids,
  collectSilhouetteEdgePixels,
  pickEvenlyPerComponentEdges
} from './RoofDripEdgeSampling.js';

const log = createLogger('RoofDripGpu');

/** Max RT dimension for readback (balance quality vs stall). */
const MAX_WORK_DIM = 900;
const MIN_WORK_DIM = 64;
/** Hard cap on listed edge pixels before polar halo (memory / CPU). */
const MAX_RAW_EDGE_PIXELS = 120000;

const VERT = `
attribute vec3 position;
attribute vec2 uv;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = `
precision highp float;
uniform sampler2D tRoof;
uniform vec2 uSrcTexel;
uniform float uAlphaThresh;
varying vec2 vUv;

void main() {
  float c = texture2D(tRoof, vUv).a;
  float r = texture2D(tRoof, vUv + vec2(uSrcTexel.x, 0.0)).a;
  float l = texture2D(tRoof, vUv - vec2(uSrcTexel.x, 0.0)).a;
  float t = texture2D(tRoof, vUv + vec2(0.0, uSrcTexel.y)).a;
  float b = texture2D(tRoof, vUv - vec2(0.0, uSrcTexel.y)).a;

  float gx = r - l;
  float gy = t - b;
  float core = min(min(r, l), min(t, b));
  float gradWeight = (c >= uAlphaThresh)
    ? mix(0.45, 1.0, smoothstep(uAlphaThresh - 0.04, uAlphaThresh + 0.14, core))
    : 0.0;
  gx *= gradWeight;
  gy *= gradWeight;
  float glen = length(vec2(gx, gy)) + 1e-5;
  vec2 n2 = vec2(gx, gy) / glen;

  float rawEdge = 0.0;
  if (c >= uAlphaThresh) {
    if (r < uAlphaThresh || l < uAlphaThresh || t < uAlphaThresh || b < uAlphaThresh) {
      rawEdge = 1.0;
    }
  }

  gl_FragColor = vec4(
    c,
    rawEdge,
    n2.x * 0.5 + 0.5,
    n2.y * 0.5 + 0.5
  );
}
`;

export class RoofDripGpuSilhouetteReadback {
  constructor() {
    this._rt = null;
    this._scene = null;
    this._camera = null;
    this._mesh = null;
    this._material = null;
    this._readBuf = null;
    this._reachScratch = null;
    this._bfsQueue = null;
    this._workW = 0;
    this._workH = 0;
    this._ndc = null;
    this._raycaster = null;
    this._plane = null;
    this._planeNormal = null;
    this._hit = null;
  }

  dispose() {
    try {
      this._rt?.dispose?.();
    } catch (_) {}
    try {
      this._material?.dispose?.();
    } catch (_) {}
    try {
      this._mesh?.geometry?.dispose?.();
    } catch (_) {}
    this._rt = null;
    this._scene = null;
    this._camera = null;
    this._mesh = null;
    this._material = null;
    this._readBuf = null;
    this._reachScratch = null;
    this._bfsQueue = null;
    this._raycaster = null;
    this._plane = null;
    this._planeNormal = null;
    this._ndc = null;
    this._hit = null;
    this._workW = 0;
    this._workH = 0;
  }

  _ensureResources(THREE, workW, workH) {
    if (this._workW === workW && this._workH === workH && this._rt && this._material) return;

    this.dispose();
    this._workW = workW;
    this._workH = workH;

    this._rt = new THREE.WebGLRenderTarget(workW, workH, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType
    });

    this._material = new THREE.ShaderMaterial({
      uniforms: {
        tRoof: { value: null },
        uSrcTexel: { value: new THREE.Vector2(1, 1) },
        uAlphaThresh: { value: 0.16 }
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false
    });

    const geom = new THREE.PlaneGeometry(2, 2);
    this._mesh = new THREE.Mesh(geom, this._material);
    this._scene = new THREE.Scene();
    this._scene.add(this._mesh);
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    this._camera.position.z = 1;
    this._camera.lookAt(0, 0, 0);
  }

  /**
   * @param {object} opts
   * @param {typeof THREE} opts.THREE
   * @param {THREE.WebGLRenderer} opts.renderer
   * @param {THREE.Texture} opts.roofAlphaTexture
   * @param {number} opts.srcW - roof RT width (texture space == screenUv space)
   * @param {number} opts.srcH
   * @param {number} opts.alphaThreshold - 0..1
   * @param {number} opts.maxSpawnPoints - reservoir cap
   * @param {number} opts.spawnZWorld
   * @param {THREE.Camera} opts.camera - scene camera for screenUv → world
   * @param {(wx: number, wy: number) => {u: number, v: number}|null} opts.worldToSceneUv
   * @returns {number[]|null} stride-5 u,v,nx,ny,zScene
   */
  extractSpawnStride5(opts) {
    const {
      THREE,
      renderer,
      roofAlphaTexture,
      srcW,
      srcH,
      alphaThreshold,
      maxSpawnPoints,
      spawnZWorld,
      camera,
      worldToSceneUv
    } = opts;

    if (!THREE || !renderer || !roofAlphaTexture || !camera || !worldToSceneUv) return null;
    if (!srcW || !srcH || !Number.isFinite(spawnZWorld)) return null;

    let workW = srcW;
    let workH = srcH;
    const scale = Math.min(1, MAX_WORK_DIM / Math.max(workW, workH));
    workW = Math.max(MIN_WORK_DIM, Math.floor(workW * scale));
    workH = Math.max(MIN_WORK_DIM, Math.floor(workH * scale));

    try {
      this._ensureResources(THREE, workW, workH);
    } catch (e) {
      log.warn('GPU roof drip: failed to create RT/shader', e);
      return null;
    }

    this._material.uniforms.tRoof.value = roofAlphaTexture;
    this._material.uniforms.uSrcTexel.value.set(1 / srcW, 1 / srcH);
    this._material.uniforms.uAlphaThresh.value = alphaThreshold;

    const prevTarget = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    const prevAutoClear = renderer.autoClear;
    try {
      renderer.xr.enabled = false;
      renderer.autoClear = true;
      renderer.setRenderTarget(this._rt);
      renderer.clear(true, true, true);
      renderer.render(this._scene, this._camera);
    } catch (e) {
      log.warn('GPU roof drip: render failed', e);
      try {
        renderer.setRenderTarget(prevTarget);
        renderer.autoClear = prevAutoClear;
        renderer.xr.enabled = prevXr;
      } catch (_) {}
      return null;
    }
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    renderer.xr.enabled = prevXr;

    const nPix = workW * workH;
    if (!this._readBuf || this._readBuf.length < nPix * 4) {
      this._readBuf = new Uint8Array(nPix * 4);
    }
    try {
      renderer.readRenderTargetPixels(this._rt, 0, 0, workW, workH, this._readBuf);
    } catch (e) {
      log.warn('GPU roof drip: readRenderTargetPixels failed', e);
      return null;
    }

    const alphaByte = Math.max(0, Math.min(255, Math.floor(alphaThreshold * 255)));
    if (!this._reachScratch || this._reachScratch.length < nPix) {
      this._reachScratch = new Uint8Array(nPix);
      this._bfsQueue = new Int32Array(nPix);
    }
    this._floodExteriorTransparentFromReadback(workW, workH, alphaByte);

    const labels = labelOpaqueComponents4(this._readBuf, workW, workH, alphaByte, 0);
    const centroids = componentOpaqueCentroids(labels, workW, workH);

    const rawPx = [];
    const rawPy = [];
    let scanStride = 1;
    const tryCollect = () => {
      rawPx.length = 0;
      rawPy.length = 0;
      collectSilhouetteEdgePixels(
        this._readBuf,
        workW,
        workH,
        alphaByte,
        this._reachScratch,
        rawPx,
        rawPy,
        MAX_RAW_EDGE_PIXELS,
        scanStride,
        0
      );
    };
    tryCollect();
    while (rawPx.length >= MAX_RAW_EDGE_PIXELS && scanStride < 4) {
      scanStride++;
      tryCollect();
    }

    const nEdge = rawPx.length;
    if (nEdge < 4) return null;

    const maxOut = Math.max(8, Math.min(8192, maxSpawnPoints | 0));
    let halo = pickEvenlyPerComponentEdges(
      rawPx,
      rawPy,
      nEdge,
      labels,
      workW,
      centroids,
      maxOut
    );
    if (halo.length < 8) {
      halo = this._pickEvenlyStridedAlongAngleSortedEdge(rawPx, rawPy, nEdge, maxOut);
    }
    if (halo.length < 4) return null;

    if (!this._ndc) this._ndc = new THREE.Vector2();
    if (!this._raycaster) this._raycaster = new THREE.Raycaster();
    if (!this._plane) this._plane = new THREE.Plane();
    if (!this._hit) this._hit = new THREE.Vector3();
    if (!this._planeNormal) this._planeNormal = new THREE.Vector3(0, 0, 1);

    const ndcMode = this._probeBestNdcMode(
      THREE,
      camera,
      halo,
      workW,
      workH,
      spawnZWorld,
      worldToSceneUv
    );

    const out = [];
    for (let i = 0; i < halo.length; i += 2) {
      const px = halo[i];
      const py = halo[i + 1];
      const su = (px + 0.5) / workW;
      const sv = (py + 0.5) / workH;

      if (!this._rayWorldOnPlane(su, sv, ndcMode, camera, spawnZWorld, this._hit, THREE)) {
        continue;
      }

      const ii = (py * workW + px) * 4;
      const nnx = (this._readBuf[ii + 2] / 255) * 2 - 1;
      const nny = (this._readBuf[ii + 3] / 255) * 2 - 1;
      const nlen = Math.hypot(nnx, nny);
      const nx = nlen > 1e-5 ? nnx / nlen : 0;
      const ny = nlen > 1e-5 ? nny / nlen : 1;

      const uv = worldToSceneUv(this._hit.x, this._hit.y);
      if (!uv) continue;
      if (uv.u < -0.05 || uv.u > 1.05 || uv.v < -0.05 || uv.v > 1.05) continue;
      out.push(Math.max(0, Math.min(1, uv.u)));
      out.push(Math.max(0, Math.min(1, uv.v)));
      out.push(nx);
      out.push(ny);
      out.push(spawnZWorld);
    }

    return out.length >= 5 ? out : null;
  }

  /**
   * Legacy single-centroid polar stride (fallback if per-component pick yields too few).
   * @returns {number[]} interleaved px,py
   */
  _pickEvenlyStridedAlongAngleSortedEdge(px, py, n, targetK) {
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < n; i++) {
      cx += px[i];
      cy += py[i];
    }
    cx /= n;
    cy /= n;

    const ang = new Float64Array(n);
    const rad = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const dx = px[i] - cx;
      const dy = py[i] - cy;
      ang[i] = Math.atan2(dy, dx);
      rad[i] = dx * dx + dy * dy;
    }

    const order = new Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => ang[a] - ang[b] || rad[a] - rad[b]);

    const K = Math.min(Math.max(1, targetK | 0), n);
    const out = [];
    if (K === 1) {
      out.push(px[order[0]], py[order[0]]);
      return out;
    }
    for (let k = 0; k < K; k++) {
      const j = Math.floor((k * (n - 1)) / (K - 1));
      const ii = order[j];
      out.push(px[ii], py[ii]);
    }
    return out;
  }

  /**
   * ndcMode: 0 = (su,sv) standard, 1 = flip V before NDC, 2 = flip NDC y sign, 3 = both
   */
  _ndcFromScreenUv(su, sv, mode, outNdc) {
    const vTex = mode & 1 ? 1 - sv : sv;
    let ndcY = vTex * 2 - 1;
    if (mode & 2) ndcY = -ndcY;
    outNdc.set(su * 2 - 1, ndcY);
  }

  _rayWorldOnPlane(su, sv, ndcMode, camera, spawnZWorld, hit, THREE) {
    if (!this._planeNormal) this._planeNormal = new THREE.Vector3(0, 0, 1);
    this._plane.set(this._planeNormal, -spawnZWorld);
    this._ndcFromScreenUv(su, sv, ndcMode, this._ndc);
    this._raycaster.setFromCamera(this._ndc, camera);
    return !!this._raycaster.ray.intersectPlane(this._plane, hit);
  }

  _probeBestNdcMode(THREE, camera, halo, workW, workH, spawnZWorld, worldToSceneUv) {
    let best = 0;
    let bestScore = -1;
    const step = Math.max(2, (Math.floor(halo.length / 8) & ~1) || 2);
    for (let mode = 0; mode < 4; mode++) {
      let score = 0;
      for (let i = 0; i < halo.length; i += step) {
        const px = halo[i];
        const py = halo[i + 1];
        const su = (px + 0.5) / workW;
        const sv = (py + 0.5) / workH;
        if (this._rayWorldOnPlane(su, sv, mode, camera, spawnZWorld, this._hit, THREE)) {
          const uv = worldToSceneUv(this._hit.x, this._hit.y);
          if (uv && uv.u >= -0.05 && uv.u <= 1.05 && uv.v >= -0.05 && uv.v <= 1.05) {
            score++;
          }
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = mode;
      }
    }
    return best;
  }

  _floodExteriorTransparentFromReadback(workW, workH, alphaByte) {
    const reach = this._reachScratch;
    const q = this._bfsQueue;
    const buf = this._readBuf;
    const n = workW * workH;
    reach.fill(0);
    let qt = 0;

    const push = (x, y) => {
      if (x < 0 || x >= workW || y < 0 || y >= workH) return;
      const idx = y * workW + x;
      if (reach[idx]) return;
      if (buf[idx * 4] >= alphaByte) return;
      reach[idx] = 1;
      q[qt++] = idx;
    };

    for (let x = 0; x < workW; x++) {
      push(x, 0);
      push(x, workH - 1);
    }
    for (let y = 0; y < workH; y++) {
      push(0, y);
      push(workW - 1, y);
    }

    let qh = 0;
    while (qh < qt) {
      const cur = q[qh++];
      const x = cur % workW;
      const y = (cur / workW) | 0;
      push(x - 1, y);
      push(x + 1, y);
      push(x, y - 1);
      push(x, y + 1);
    }
  }
}
