/**
 * @fileoverview Option B: Map Shine–owned occlusion mask RT mirroring Foundry’s
 * radial + vision semantics (green = radial, blue = vision/line-of-sight),
 * consumed by bus materials via `step`/`mix`. No PIXI `extract.canvas`
 * readback — one fullscreen fragment pass per frame, plus a real-geometry
 * vision pass that draws controlled-token LOS polygons through the bus
 * camera so RADIAL and VISION holes share the same parallax model.
 *
 * @module compositor-v2/ReplicaOcclusionMaskPass
 */
import { createLogger } from '../core/log.js';
import { VisionPolygonComputer } from '../vision/VisionPolygonComputer.js';
import { GROUND_Z } from './LayerOrderPolicy.js';

const log = createLogger('ReplicaOcclusionMaskPass');

/** Hard cap on simultaneous LOS polygons rendered per frame (perf safety). */
const REPLICA_OCCLUSION_VISION_TOKEN_CAP = 8;

/** Lift vision polygons a hair above ground Z so they don't z-fight with floor 0 effects.
 *  Depth test is disabled, but we keep the offset for any future depth-enabled debug pass.
 */
const REPLICA_VISION_Z_OFFSET = 0.05;

/** Must match {@link TILE_RADIAL_OCCLUSION_TOKEN_CAP} in tile-manager.js */
export const REPLICA_OCCLUSION_TOKEN_CAP = 8;

/** Defaults match Map Shine Control panel + `control-state-sanitize.js`. */
export const REPLICA_OCCLUSION_RADIUS_SCALE_DEFAULT = 35.0;
export const REPLICA_OCCLUSION_EDGE_SOFTNESS_DEFAULT = 1.0;

/**
 * Live + persisted GM tunables for V2 replica overhead occlusion (Map Shine Control).
 * Reads local panel state first, then scene `controlState` flag (all clients).
 * @returns {{ radiusScale: number, edgeSoftness: number }}
 */
export function getReplicaOcclusionTunables() {
  let cs = null;
  try {
    cs = window.MapShine?.controlPanel?.controlState ?? null;
  } catch (_) {
    cs = null;
  }
  if (!cs && typeof canvas !== 'undefined') {
    try {
      cs = canvas.scene?.getFlag?.('map-shine-advanced', 'controlState') ?? null;
    } catch (_) {
      cs = null;
    }
  }
  let rs = Number(cs?.replicaOcclusionRadiusScale);
  let es = Number(cs?.replicaOcclusionEdgeSoftness);
  if (!Number.isFinite(rs)) rs = REPLICA_OCCLUSION_RADIUS_SCALE_DEFAULT;
  if (!Number.isFinite(es)) es = REPLICA_OCCLUSION_EDGE_SOFTNESS_DEFAULT;
  rs = Math.max(0.05, Math.min(100, rs));
  es = Math.max(0, Math.min(100, es));
  return { radiusScale: rs, edgeSoftness: es };
}

const FS = `
uniform vec2 uResolution;
uniform int uCount;
uniform vec3 uTok[8];
uniform float uGreen[8];
uniform float uRadiusScale;
uniform float uEdgeSoftness;
uniform sampler2D uVisionTex;
uniform int uVisionEnabled;

void main() {
  vec2 frag = gl_FragCoord.xy;
  float canvasY = uResolution.y - frag.y;
  vec2 px = vec2(frag.x, canvasY);
  float g = 1.0;
  float rs = clamp(uRadiusScale, 0.05, 100.0);
  float S = clamp(uEdgeSoftness, 0.0, 100.0);
  // 0 = sharp rim, 1 = legacy default (mult 1), 100 = very wide feather (mult ~50 on stockFw).
  float edgeMul = mix(0.02, 1.0, min(S, 1.0)) + max(0.0, S - 1.0) * (49.0 / 99.0);
  for (int i = 0; i < 8; i++) {
    if (i < uCount) {
      vec3 t = uTok[i];
      float te = uGreen[i];
      float d = distance(px, t.xy);
      float rad = max(1.0, t.z * rs);
      float stockFw = max(2.0, rad * 0.04);
      float fw = max(0.35, stockFw * edgeMul);
      float inner = 1.0 - smoothstep(rad - fw, rad + fw, d);
      g = min(g, mix(1.0, te, inner));
    }
  }
  // B channel = VISION / Line-of-Sight occluder mask, in bus screen space.
  // Source RT is rendered through the bus camera with controlled-token LOS
  // polygons (filled black, otherwise white). 0 = covered = tile hidden.
  // bus shader path: foMask.b < uMsFoundryOccElev → ms_foOcc.b = 1 → fade.
  float vis = 1.0;
  if (uVisionEnabled == 1) {
    vis = texture2D(uVisionTex, frag / uResolution).r;
  }
  gl_FragColor = vec4(0.0, g, vis, 1.0);
}
`;

/** Vision polygon vertex shader: standard MVP, polygons authored in bus world coords. */
const VISION_POLY_VS = `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** Vision polygon fragment shader: pure black (covered = occluded in B channel). */
const VISION_POLY_FS = `
void main() {
  gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
}
`;

const VS = `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Fullscreen copy: sample draw RT into a separate texture so bus passes never sample an RT color attachment while rendering to another RT (avoids GL feedback-loop warnings). */
const COPY_FS = `
uniform sampler2D tSource;
uniform vec2 uRes;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  gl_FragColor = texture2D(tSource, uv);
}
`;

/**
 * Map a **Three world** point to replica mask pixel space `px` used in
 * {@link ReplicaOcclusionMaskPass} FS (`px.x = gl_FragCoord.x`, `px.y = uResolution.y - gl_FragCoord.y`).
 * Must match the same `camera` + buffer size as {@link FloorRenderBus#renderTo} → scene RT
 * (fixes parallax vs `clientCoordinatesFromCanvas`, which follows the 2D Foundry stage).
 *
 * @param {object} THREE
 * @param {import('three').Camera} camera
 * @param {number} worldX
 * @param {number} worldY
 * @param {number} worldZ
 * @param {number} busW
 * @param {number} busH
 * @returns {{ x: number, y: number }|null}
 */
export function worldToReplicaMaskPx(THREE, camera, worldX, worldY, worldZ, busW, busH) {
  if (!THREE || !camera || !Number.isFinite(busW) || !Number.isFinite(busH) || busW < 2 || busH < 2) {
    return null;
  }
  try {
    const v = new THREE.Vector3(Number(worldX), Number(worldY), Number(worldZ));
    v.project(camera);
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return null;
    const gx = (v.x * 0.5 + 0.5) * busW;
    const gy = (v.y * 0.5 + 0.5) * busH;
    return { x: gx, y: busH - gy };
  } catch (_) {
    return null;
  }
}

/** Match `TOKEN_BASE_Z_V2` in `scene/token-manager.js` when the V2 bus compositor is active. */
const TOKEN_BASE_Z_V2 = 1003.0;

/**
 * @param {object} THREE
 * @param {object} token - Foundry `Token`
 * @returns {import('three').Vector3|null}
 */
function getTokenWorldCenterForReplica(THREE, token) {
  if (!THREE || !token?.document) return null;
  const id = String(token.id ?? token.document?.id ?? '');
  const spr = window.MapShine?.tokenManager?.tokenSprites?.get?.(id)?.sprite;
  const v = new THREE.Vector3();
  if (spr && typeof spr.getWorldPosition === 'function') {
    spr.updateWorldMatrix?.(true, false);
    spr.getWorldPosition(v);
    return v;
  }
  try {
    const doc = token.document;
    const grid = typeof canvas !== 'undefined' ? canvas?.grid : null;
    const gridSizeX = (grid && typeof grid.sizeX === 'number' && grid.sizeX > 0)
      ? grid.sizeX
      : ((grid && typeof grid.size === 'number' && grid.size > 0) ? grid.size : 100);
    const gridSizeY = (grid && typeof grid.sizeY === 'number' && grid.sizeY > 0)
      ? grid.sizeY
      : ((grid && typeof grid.size === 'number' && grid.size > 0) ? grid.size : 100);
    const rectWidth = doc.width * gridSizeX;
    const rectHeight = doc.height * gridSizeY;
    const centerX = doc.x + rectWidth / 2;
    const sceneHeight = canvas?.dimensions?.height || 10000;
    const centerY = sceneHeight - (doc.y + rectHeight / 2);
    const elevation = doc.elevation || 0;
    const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
    const v2 = !!(window.MapShine?.floorCompositorV2 || window.MapShine?.effectComposer?._floorCompositorV2);
    const zPosition = groundZ + (v2 ? TOKEN_BASE_Z_V2 : 3.0) + elevation;
    v.set(centerX, centerY, zPosition);
    return v;
  } catch (_) {
    return null;
  }
}

/**
 * Foundry `token.center` / `getCenterPoint()` are **canvas world** coordinates (can be
 * far outside the visible screen). The replica RT matches the Three **drawing buffer**,
 * so we map through `canvas.clientCoordinatesFromCanvas` then scale by buffer / client size.
 *
 * @param {object} cnv - Foundry `canvas`
 * @param {number} wx
 * @param {number} wy
 * @returns {{ x: number, y: number }|null}
 */
export function worldToReplicaDrawingPx(cnv, wx, wy, busW, busH) {
  if (!cnv || typeof cnv.clientCoordinatesFromCanvas !== 'function') return null;
  try {
    const p = cnv.clientCoordinatesFromCanvas({ x: wx, y: wy });
    let x = Number(p?.x);
    let y = Number(p?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const el = cnv.app?.canvas;
    const cw = Number(el?.clientWidth);
    const ch = Number(el?.clientHeight);
    if (Number.isFinite(busW) && busW > 0 && Number.isFinite(cw) && cw > 0) x *= busW / cw;
    if (Number.isFinite(busH) && busH > 0 && Number.isFinite(ch) && ch > 0) y *= busH / ch;
    return { x, y };
  } catch (_) {
    return null;
  }
}

/**
 * @param {object} cnv
 * @param {number} wx
 * @param {number} wy
 * @param {number} rWorld
 * @param {number} busW
 * @param {number} busH
 * @returns {number|null}
 */
function worldRadiusToReplicaDrawingPx(cnv, wx, wy, rWorld, busW, busH) {
  const rw = Math.max(1e-6, Number(rWorld) || 0);
  const p0 = worldToReplicaDrawingPx(cnv, wx, wy, busW, busH);
  const px = worldToReplicaDrawingPx(cnv, wx + rw, wy, busW, busH);
  const py = worldToReplicaDrawingPx(cnv, wx, wy + rw, busW, busH);
  if (!p0 || !px || !py) return null;
  const rPix = Math.max(Math.hypot(px.x - p0.x, px.y - p0.y), Math.hypot(py.x - p0.x, py.y - p0.y));
  return Math.max(1, rPix);
}

/**
 * @param {object} THREE
 * @param {import('three').Camera} camera
 * @param {number} ox - Foundry canvas X (token.center)
 * @param {number} oy - Foundry canvas Y
 * @param {number} rCanvas
 * @param {number} worldZ
 * @param {number} busW
 * @param {number} busH
 * @returns {number|null}
 */
function worldRadiusToReplicaMaskPx(THREE, camera, ox, oy, rCanvas, worldZ, busW, busH) {
  const Coords = typeof globalThis !== 'undefined' ? globalThis.Coordinates : null;
  if (!Coords?.toWorld || !THREE || !camera) return null;
  const rw = Math.max(1e-6, Number(rCanvas) || 0);
  try {
    const w0 = Coords.toWorld(ox, oy);
    const wx = Coords.toWorld(ox + rw, oy);
    const wy = Coords.toWorld(ox, oy + rw);
    const p0 = worldToReplicaMaskPx(THREE, camera, w0.x, w0.y, worldZ, busW, busH);
    const p1 = worldToReplicaMaskPx(THREE, camera, wx.x, wx.y, worldZ, busW, busH);
    const p2 = worldToReplicaMaskPx(THREE, camera, wy.x, wy.y, worldZ, busW, busH);
    if (!p0 || !p1 || !p2) return null;
    const rPix = Math.max(Math.hypot(p1.x - p0.x, p1.y - p0.y), Math.hypot(p2.x - p0.x, p2.y - p0.y));
    return Math.max(1, rPix);
  } catch (_) {
    return null;
  }
}

/**
 * @param {number} busW
 * @param {number} busH
 * @param {import('three').Camera|null} camera
 */
function collectOccludableTokensForReplica(busW, busH, camera) {
  const out = [];
  const THREE = typeof window !== 'undefined' ? window.THREE : null;
  try {
    const layer = typeof canvas !== 'undefined' ? canvas?.tokens : null;
    const fn = layer?._getOccludableTokens;
    const arr = typeof fn === 'function' ? fn.call(layer) : null;
    const tokens = Array.isArray(arr) ? arr : [];
    const sorted = [...tokens].sort((a, b) => {
      const ea = Number(a?.document?.elevation ?? 0);
      const eb = Number(b?.document?.elevation ?? 0);
      return (Number.isFinite(ea) && Number.isFinite(eb)) ? ea - eb : 0;
    });
    const useCam = !!(THREE && camera && (camera.isPerspectiveCamera || camera.isOrthographicCamera));
    for (const t of sorted) {
      if (!t?.document || !t.center) continue;
      const origin = t.center;
      const ox = Number(origin.x);
      const oy = Number(origin.y);
      if (!Number.isFinite(ox) || !Number.isFinite(oy)) continue;

      let r = 0;
      try {
        r = Math.max(r, Number(t.externalRadius) || 0);
      } catch (_) {
      }
      try {
        const lr = t.getLightRadius?.(t.document?.occludable?.radius);
        if (Number.isFinite(lr)) r = Math.max(r, lr);
      } catch (_) {
      }
      r = Math.max(1.0, r);

      let g = 0.5;
      try {
        if (canvas?.masks?.occlusion?.mapElevation) {
          g = Number(canvas.masks.occlusion.mapElevation(t.document.elevation ?? 0));
        }
      } catch (_) {
        g = 0.5;
      }
      g = Math.max(0.0, Math.min(1.0, g));

      let sx = ox;
      let sy = oy;
      let sr = r;

      if (useCam) {
        const wv = getTokenWorldCenterForReplica(THREE, t);
        if (wv) {
          const scr = worldToReplicaMaskPx(THREE, camera, wv.x, wv.y, wv.z, busW, busH);
          if (scr) {
            sx = scr.x;
            sy = scr.y;
            let rPx = worldRadiusToReplicaMaskPx(THREE, camera, ox, oy, r, wv.z, busW, busH);
            if (!Number.isFinite(rPx)) {
              const cnv = typeof canvas !== 'undefined' ? canvas : null;
              rPx = worldRadiusToReplicaDrawingPx(cnv, ox, oy, r, busW, busH);
            }
            if (Number.isFinite(rPx)) sr = rPx;
          }
        }
      }
      if (!useCam || (sx === ox && sy === oy)) {
        const cnv = typeof canvas !== 'undefined' ? canvas : null;
        const scr = worldToReplicaDrawingPx(cnv, ox, oy, busW, busH);
        if (scr) {
          sx = scr.x;
          sy = scr.y;
          const rPx = worldRadiusToReplicaDrawingPx(cnv, ox, oy, r, busW, busH);
          if (Number.isFinite(rPx)) sr = rPx;
        }
      }

      out.push({ x: sx, y: sy, r: sr, g });
      if (out.length >= REPLICA_OCCLUSION_TOKEN_CAP) break;
    }
  } catch (e) {
    log.debug(`replica token gather failed: ${e?.message ?? e}`);
  }
  return out;
}

/**
 * Collect controlled tokens that have vision, for VISION-mode LOS polygon rendering.
 * Mirrors {@link VisionManager} controlled-token model so player and GM views behave
 * predictably: GM with nothing selected → no VISION holes (matches Foundry's
 * `_occlusionState.vision` staying 0 when no source covers the tile).
 *
 * @returns {Array<{ tokenId: string, center: { x: number, y: number }, radiusPx: number, elevation: number }>}
 */
function collectVisionSourcesForReplica() {
  const out = [];
  try {
    if (typeof canvas === 'undefined' || !canvas?.tokens) return out;
    const controlled = canvas.tokens.controlled ?? [];
    if (!Array.isArray(controlled) || controlled.length === 0) return out;
    const gsm = window.MapShine?.gameSystem ?? null;
    const dims = canvas.dimensions;
    const gridSize = Number(dims?.size) || 100;
    const gridDistance = Number(dims?.distance) || 5;
    for (const token of controlled) {
      const doc = token?.document;
      if (!doc) continue;
      if (doc.hidden) continue;
      const hasVision = gsm
        ? gsm.hasTokenVision(token)
        : (token.hasSight || doc.sight?.enabled);
      if (!hasVision) continue;
      let radiusPx = 0;
      if (gsm && typeof gsm.getTokenVisionRadius === 'function') {
        const dist = Number(gsm.getTokenVisionRadius(token));
        if (Number.isFinite(dist) && dist > 0 && typeof gsm.distanceToPixels === 'function') {
          radiusPx = Number(gsm.distanceToPixels(dist)) || 0;
        }
      }
      if (!(radiusPx > 0)) {
        const sightRange = Number(doc.sight?.range ?? token.sightRange ?? 0);
        if (sightRange > 0 && gridDistance > 0) {
          radiusPx = (sightRange / gridDistance) * gridSize;
        }
      }
      if (!(radiusPx > 0) && (token.hasSight || doc.sight?.enabled)) {
        // Unlimited / "very large" sight → use a generous fallback so VISION holes
        // still appear when a token has sight enabled with no explicit range.
        radiusPx = gridDistance > 0 ? (1000 / gridDistance) * gridSize : 5000;
      }
      if (!(radiusPx > 0)) continue;
      const tokenWidth = (Number(doc.width) || 1) * gridSize;
      const tokenHeight = (Number(doc.height) || 1) * gridSize;
      const cx = (Number(doc.x) || 0) + tokenWidth / 2;
      const cy = (Number(doc.y) || 0) + tokenHeight / 2;
      const elevation = Number(doc.elevation ?? 0);
      out.push({
        tokenId: String(doc.id ?? token.id ?? ''),
        center: { x: cx, y: cy },
        radiusPx,
        elevation: Number.isFinite(elevation) ? elevation : 0,
      });
      if (out.length >= REPLICA_OCCLUSION_VISION_TOKEN_CAP) break;
    }
  } catch (e) {
    log.debug(`collectVisionSourcesForReplica failed: ${e?.message ?? e}`);
  }
  return out;
}

/** Earcut accessor with PIXI / global fallbacks (matches GeometryConverter). */
function _resolveEarcut() {
  try {
    if (typeof PIXI !== 'undefined' && PIXI?.utils?.earcut) return PIXI.utils.earcut;
  } catch (_) {}
  if (typeof window !== 'undefined' && window.earcut) return window.earcut;
  try {
    const ec = canvas?.app?.renderer?.plugins?.extract?.earcut;
    if (ec) return ec;
  } catch (_) {}
  return null;
}

export class ReplicaOcclusionMaskPass {
  constructor() {
    /** @type {import('three').WebGLRenderTarget|null} */
    this._rt = null;
    /** @type {import('three').WebGLRenderTarget|null} */
    this._rtResolved = null;
    /** @type {import('three').WebGLRenderTarget|null} VISION-mode LOS mask (bus screen space). */
    this._rtVision = null;
    /** @type {number} */
    this._rtW = 0;
    /** @type {number} */
    this._rtH = 0;
    /** @type {number} */
    this._busBufW = 1;
    /** @type {number} */
    this._busBufH = 1;
    /** @type {boolean} */
    this.valid = false;
    /** @type {import('three').ShaderMaterial|null} */
    this._material = null;
    /** @type {import('three').Mesh|null} */
    this._mesh = null;
    /** @type {import('three').Scene|null} */
    this._scene = null;
    /** @type {import('three').OrthographicCamera|null} */
    this._camera = null;
    /** @type {import('three').ShaderMaterial|null} */
    this._copyMaterial = null;
    /** @type {import('three').Mesh|null} */
    this._copyMesh = null;
    /** @type {import('three').Scene|null} */
    this._copyScene = null;
    /** @type {import('three').OrthographicCamera|null} */
    this._copyCamera = null;

    /** @type {import('three').Scene|null} VISION polygon scene, rendered with bus camera. */
    this._visionScene = null;
    /** @type {import('three').ShaderMaterial|null} */
    this._visionMaterial = null;
    /** @type {VisionPolygonComputer|null} */
    this._visionComputer = null;
    /** @type {Map<string, import('three').Mesh>} */
    this._visionMeshes = new Map();
    /** @type {boolean} True when the most recent update() built at least one polygon mesh. */
    this._visionActive = false;
  }

  /**
   * @param {number} w
   * @param {number} h
   */
  setBusRenderTargetSize(w, h) {
    this._busBufW = Math.max(1, Math.floor(Number(w)) || 1);
    this._busBufH = Math.max(1, Math.floor(Number(h)) || 1);
  }

  /**
   * @returns {{ invW: number, invH: number }}
   */
  getBusInvBufSize() {
    return { invW: 1 / this._busBufW, invH: 1 / this._busBufH };
  }

  /**
   * @returns {import('three').Texture|null}
   */
  getTexture() {
    return this._rtResolved?.texture ?? this._rt?.texture ?? null;
  }

  /**
   * RT used for `readRenderTargetPixels` / probes (resolved copy, same size as mask).
   * @returns {import('three').WebGLRenderTarget|null}
   */
  getSampleRenderTarget() {
    return this._rtResolved ?? this._rt ?? null;
  }

  /**
   * @param {import('three').WebGLRenderer} renderer
   * @private
   */
  _ensureResources(renderer) {
    const THREE = window.THREE;
    if (!THREE || !renderer) return;
    const w = this._busBufW;
    const h = this._busBufH;
    if (w < 2 || h < 2) {
      this.valid = false;
      return;
    }
    if (this._rt && this._rtResolved && this._rtVision && this._rtW === w && this._rtH === h) {
      if (this._material?.uniforms?.uRadiusScale && this._material?.uniforms?.uEdgeSoftness) return;
    }

    try {
      this._rt?.dispose?.();
    } catch (_) {
    }
    try {
      this._rtResolved?.dispose?.();
    } catch (_) {
    }
    try {
      this._rtVision?.dispose?.();
    } catch (_) {
    }
    try {
      this._copyMesh?.geometry?.dispose?.();
    } catch (_) {
    }
    try {
      this._copyMaterial?.dispose?.();
    } catch (_) {
    }
    this._rt = null;
    this._rtResolved = null;
    this._rtVision = null;
    this._mesh = null;
    this._material = null;
    this._scene = null;
    this._camera = null;
    this._copyMesh = null;
    this._copyMaterial = null;
    this._copyScene = null;
    this._copyCamera = null;

    const rtOpts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      colorSpace: THREE.NoColorSpace ?? THREE.LinearSRGBColorSpace,
    };
    this._rt = new THREE.WebGLRenderTarget(w, h, rtOpts);
    this._rtResolved = new THREE.WebGLRenderTarget(w, h, rtOpts);
    this._rtVision = new THREE.WebGLRenderTarget(w, h, rtOpts);
    this._rtW = w;
    this._rtH = h;

    const tok = [];
    const green = new Float32Array(8);
    for (let i = 0; i < 8; i++) {
      tok.push(new THREE.Vector3(0, 0, 0));
      green[i] = 1.0;
    }

    this._material = new THREE.ShaderMaterial({
      uniforms: {
        uResolution: { value: new THREE.Vector2(w, h) },
        uCount: { value: 0 },
        uTok: { value: tok },
        uGreen: { value: green },
        uRadiusScale: { value: REPLICA_OCCLUSION_RADIUS_SCALE_DEFAULT },
        uEdgeSoftness: { value: REPLICA_OCCLUSION_EDGE_SOFTNESS_DEFAULT },
        uVisionTex: { value: this._rtVision.texture },
        uVisionEnabled: { value: 0 },
      },
      vertexShader: VS,
      fragmentShader: FS,
      depthTest: false,
      depthWrite: false,
    });

    // Three expects `position` itemSize 3 for bounding-sphere / frustum math; itemSize 2
    // leaves Z undefined and `computeBoundingSphere()` becomes NaN during `render()`.
    const geom = new THREE.BufferGeometry();
    geom.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
    );
    this._mesh = new THREE.Mesh(geom, this._material);
    this._scene = new THREE.Scene();
    this._scene.add(this._mesh);
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._camera.position.z = 1;

    const copyGeom = new THREE.BufferGeometry();
    copyGeom.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
    );
    this._copyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tSource: { value: null },
        uRes: { value: new THREE.Vector2(w, h) },
      },
      vertexShader: VS,
      fragmentShader: COPY_FS,
      depthTest: false,
      depthWrite: false,
    });
    this._copyMesh = new THREE.Mesh(copyGeom, this._copyMaterial);
    this._copyScene = new THREE.Scene();
    this._copyScene.add(this._copyMesh);
    this._copyCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._copyCamera.position.z = 1;

    // VISION pass — shared scene + material reused across polygon meshes.
    if (!this._visionScene) this._visionScene = new THREE.Scene();
    if (!this._visionMaterial) {
      this._visionMaterial = new THREE.ShaderMaterial({
        uniforms: {},
        vertexShader: VISION_POLY_VS,
        fragmentShader: VISION_POLY_FS,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        transparent: false,
      });
    }
    if (!this._visionComputer) this._visionComputer = new VisionPolygonComputer();

    this.valid = true;
  }

  /**
   * Rebuild VISION-mode LOS polygon meshes for currently controlled tokens with sight.
   * Polygons are authored in bus world coords (`(foundryX, sceneHeight - foundryY, GROUND_Z)`)
   * so the bus camera projects them into screen space using the same matrix as
   * tile/overhead draws. Reuses existing meshes per `tokenId` to minimize churn.
   *
   * @private
   * @returns {number} number of polygon meshes currently in the vision scene
   */
  _rebuildVisionPolygons() {
    const THREE = window.THREE;
    if (!THREE || !this._visionScene || !this._visionMaterial || !this._visionComputer) return 0;

    const earcut = _resolveEarcut();
    const sources = collectVisionSourcesForReplica();

    const dims = typeof canvas !== 'undefined' ? canvas?.dimensions : null;
    const sceneHeight = Number(dims?.height ?? dims?.sceneHeight ?? 0);
    const sceneRect = dims?.sceneRect ?? null;
    const sceneBounds = sceneRect
      ? { x: sceneRect.x, y: sceneRect.y, width: sceneRect.width, height: sceneRect.height }
      : null;
    const walls = (typeof canvas !== 'undefined' ? canvas?.walls?.placeables : null) ?? [];

    const seen = new Set();
    let active = 0;

    for (const src of sources) {
      if (!earcut) break;
      const opts = (Number.isFinite(src.elevation) && src.elevation !== 0)
        ? { elevation: src.elevation }
        : null;

      let points;
      try {
        points = this._visionComputer.compute(src.center, src.radiusPx, walls, sceneBounds, opts);
      } catch (e) {
        log.debug(`vision polygon compute failed for ${src.tokenId}: ${e?.message ?? e}`);
        continue;
      }
      if (!points || points.length < 6) continue;

      let indices;
      try {
        indices = earcut(points);
      } catch (e) {
        log.debug(`vision polygon triangulation failed for ${src.tokenId}: ${e?.message ?? e}`);
        continue;
      }
      if (!indices || indices.length < 3) continue;

      const vertCount = points.length / 2;
      const vertices = new Float32Array(vertCount * 3);
      for (let i = 0; i < vertCount; i++) {
        const fx = points[i * 2];
        const fy = points[i * 2 + 1];
        vertices[i * 3] = fx;
        vertices[i * 3 + 1] = sceneHeight - fy;
        vertices[i * 3 + 2] = GROUND_Z + REPLICA_VISION_Z_OFFSET;
      }

      const key = src.tokenId || `tok_${active}`;
      let mesh = this._visionMeshes.get(key);
      if (!mesh) {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        geom.setIndex(indices);
        mesh = new THREE.Mesh(geom, this._visionMaterial);
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        mesh.userData = { msVisionPolyTokenId: key };
        this._visionMeshes.set(key, mesh);
        this._visionScene.add(mesh);
      } else {
        try { mesh.geometry.dispose(); } catch (_) {}
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        geom.setIndex(indices);
        mesh.geometry = geom;
        if (mesh.parent !== this._visionScene) this._visionScene.add(mesh);
      }
      seen.add(key);
      active += 1;
    }

    // Remove meshes for tokens no longer providing vision.
    for (const [key, mesh] of this._visionMeshes) {
      if (seen.has(key)) continue;
      try { this._visionScene.remove(mesh); } catch (_) {}
      try { mesh.geometry?.dispose?.(); } catch (_) {}
      this._visionMeshes.delete(key);
    }

    return active;
  }

  /**
   * @param {import('three').WebGLRenderer} threeRenderer
   * @param {import('three').Camera|null} [camera=null] - FloorCompositor camera; required for correct mask alignment with bus `gl_FragCoord`.
   * @returns {boolean}
   */
  update(threeRenderer, camera = null) {
    this.valid = false;
    try {
      this._ensureResources(threeRenderer);
      if (!this._rt || !this._rtResolved || !this._rtVision || !this._material
        || !this._scene || !this._camera
        || !this._copyMaterial || !this._copyScene || !this._copyCamera) return false;

      const list = collectOccludableTokensForReplica(this._busBufW, this._busBufH, camera);
      const u = this._material.uniforms;
      const tun = getReplicaOcclusionTunables();
      if (u.uRadiusScale) u.uRadiusScale.value = tun.radiusScale;
      if (u.uEdgeSoftness) u.uEdgeSoftness.value = tun.edgeSoftness;
      u.uResolution.value.set(this._busBufW, this._busBufH);
      u.uCount.value = Math.min(REPLICA_OCCLUSION_TOKEN_CAP, list.length);
      for (let i = 0; i < REPLICA_OCCLUSION_TOKEN_CAP; i++) {
        const vec = u.uTok.value[i];
        if (i < list.length) {
          const t = list[i];
          vec.set(t.x, t.y, t.r);
          u.uGreen.value[i] = t.g;
        } else {
          vec.set(0, 0, 0);
          u.uGreen.value[i] = 1.0;
        }
      }

      // VISION / LOS — rebuild polygon meshes for controlled tokens. When no
      // tokens provide vision (GM view, none selected) the scene stays empty,
      // _rtVision stays full white, and B channel never causes occlusion.
      const visionCount = this._rebuildVisionPolygons();
      this._visionActive = visionCount > 0;
      const useVision = !!(camera && this._visionActive);
      if (u.uVisionTex) u.uVisionTex.value = this._rtVision.texture;
      if (u.uVisionEnabled) u.uVisionEnabled.value = useVision ? 1 : 0;

      const prev = threeRenderer.getRenderTarget();
      const prevAuto = threeRenderer.autoClear;
      try {
        // 1) Render VISION polygons through the bus camera into _rtVision.
        //    Clear to white = "not occluded by vision"; polygons output black.
        threeRenderer.setRenderTarget(this._rtVision);
        threeRenderer.autoClear = true;
        threeRenderer.setClearColor(0xffffff, 1);
        threeRenderer.clear(true, true, false);
        if (useVision) {
          threeRenderer.render(this._visionScene, camera);
        }

        // 2) Radial fullscreen pass — also samples _rtVision and writes its
        //    value into the B channel of _rt so bus materials see the full mask.
        threeRenderer.setRenderTarget(this._rt);
        threeRenderer.autoClear = true;
        threeRenderer.setClearColor(0x00ffff, 1);
        threeRenderer.clear(true, true, false);
        threeRenderer.render(this._scene, this._camera);

        // 3) Resolve copy — decouples sampler/attachment to avoid feedback loops.
        threeRenderer.setRenderTarget(this._rtResolved);
        threeRenderer.autoClear = true;
        threeRenderer.setClearColor(0x00ffff, 1);
        threeRenderer.clear(true, true, false);
        this._copyMaterial.uniforms.tSource.value = this._rt.texture;
        this._copyMaterial.uniforms.uRes.value.set(this._busBufW, this._busBufH);
        threeRenderer.render(this._copyScene, this._copyCamera);
      } finally {
        threeRenderer.setRenderTarget(prev);
        threeRenderer.autoClear = prevAuto;
      }

      this.valid = true;
      return true;
    } catch (e) {
      log.debug(`ReplicaOcclusionMaskPass.update failed: ${e?.message ?? e}`);
      this.valid = false;
      return false;
    }
  }

  /**
   * Whether the most recent update() produced at least one VISION polygon mesh.
   * Bus uniform plumbing uses this to gate `uMsFoundryVision` so VISION-mode
   * tiles never blend in a no-source mask (matches Foundry's `_occlusionState.vision = 0`
   * when no LOS source covers the tile).
   * @returns {boolean}
   */
  hasActiveVisionSource() {
    return !!this._visionActive;
  }

  dispose() {
    try {
      this._mesh?.geometry?.dispose?.();
    } catch (_) {
    }
    try {
      this._copyMesh?.geometry?.dispose?.();
    } catch (_) {
    }
    try {
      this._material?.dispose?.();
    } catch (_) {
    }
    try {
      this._copyMaterial?.dispose?.();
    } catch (_) {
    }
    try {
      this._rt?.dispose?.();
    } catch (_) {
    }
    try {
      this._rtResolved?.dispose?.();
    } catch (_) {
    }
    try {
      this._rtVision?.dispose?.();
    } catch (_) {
    }
    try {
      for (const mesh of this._visionMeshes.values()) {
        try { this._visionScene?.remove?.(mesh); } catch (_) {}
        try { mesh.geometry?.dispose?.(); } catch (_) {}
      }
    } catch (_) {
    }
    this._visionMeshes.clear();
    try {
      this._visionMaterial?.dispose?.();
    } catch (_) {
    }
    this._mesh = null;
    this._material = null;
    this._scene = null;
    this._camera = null;
    this._copyMesh = null;
    this._copyMaterial = null;
    this._copyScene = null;
    this._copyCamera = null;
    this._visionScene = null;
    this._visionMaterial = null;
    this._visionComputer = null;
    this._visionActive = false;
    this._rt = null;
    this._rtResolved = null;
    this._rtVision = null;
    this._rtW = 0;
    this._rtH = 0;
    this.valid = false;
    this._busBufW = 1;
    this._busBufH = 1;
  }
}
