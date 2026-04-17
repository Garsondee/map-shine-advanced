/**
 * Fullscreen debug overlay: composites a world-space mask (scene-rect UV) over the
 * final V2 post chain. Intended as the single operator-facing debug surface for
 * _Outdoors first; extend {@link MASK_DEBUG_OVERLAY_MODE_OPTIONS} for combined masks later.
 *
 * @module compositor-v2/MaskDebugOverlayPass
 */

import { createLogger } from '../core/log.js';

const log = createLogger('MaskDebugOverlayPass');

/** NDC corners for perspective → ground-plane view bounds (same idea as MaskDebugEffect). */
const _ndcCorners = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

/**
 * Tweakpane / UI labels → internal mode id.
 * Add entries when new debug textures are wired in {@link MaskDebugOverlayPass#resolveMaskTexture}.
 */
export const MASK_DEBUG_OVERLAY_MODE_OPTIONS = {
  'Outdoors (current level)': 'outdoors_current',
  'Overhead: Final Shadow Factor': 'overhead_shadow_factor',
  'Overhead: Roof Coverage Capture': 'overhead_roof_coverage',
  'Overhead: Roof Visibility (view floor)': 'overhead_roof_visibility',
  'Overhead: Roof Block': 'overhead_roof_block',
  'Overhead: Fluid Roof Capture': 'overhead_fluid_roof',
  'Overhead: Tile Projection Capture': 'overhead_tile_projection',
};

/**
 * @param {string} mode
 * @returns {boolean}
 */
export function isKnownMaskDebugOverlayMode(mode) {
  const vals = Object.values(MASK_DEBUG_OVERLAY_MODE_OPTIONS);
  return vals.includes(mode);
}

/**
 * @param {import('three').WebGLRenderer} renderer
 * @param {import('three').PerspectiveCamera|import('three').OrthographicCamera} camera
 * @param {number} groundZ
 * @param {import('three').Vector4} outVec4 minX, minY, maxX, maxY in Three XY at ground plane
 */
function updateViewBoundsFromCamera(camera, groundZ, outVec4, tempNdc, tempWorld, tempDir) {
  const THREE = window.THREE;
  if (!THREE || !outVec4 || !camera) return;

  if (camera.isOrthographicCamera) {
    const camPos = camera.position;
    const minX = camPos.x + camera.left / camera.zoom;
    const maxX = camPos.x + camera.right / camera.zoom;
    const minY = camPos.y + camera.bottom / camera.zoom;
    const maxY = camPos.y + camera.top / camera.zoom;
    outVec4.set(minX, minY, maxX, maxY);
    return;
  }

  const origin = camera.position;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < _ndcCorners.length; i++) {
    const cx = _ndcCorners[i][0];
    const cy = _ndcCorners[i][1];

    tempNdc.set(cx, cy, 0.5);
    tempWorld.copy(tempNdc).unproject(camera);

    tempDir.subVectors(tempWorld, origin).normalize();
    const dz = tempDir.z;
    if (Math.abs(dz) < 1e-6) continue;

    const t = (groundZ - origin.z) / dz;
    if (!Number.isFinite(t) || t <= 0) continue;

    const ix = origin.x + tempDir.x * t;
    const iy = origin.y + tempDir.y * t;

    if (ix < minX) minX = ix;
    if (iy < minY) minY = iy;
    if (ix > maxX) maxX = ix;
    if (iy > maxY) maxY = iy;
  }

  if (minX !== Infinity && minY !== Infinity && maxX !== -Infinity && maxY !== -Infinity) {
    outVec4.set(minX, minY, maxX, maxY);
  }
}

export class MaskDebugOverlayPass {
  constructor() {
    /** @type {import('three').ShaderMaterial|null} */
    this._material = null;
    /** @type {import('three').Scene|null} */
    this._scene = null;
    /** @type {import('three').OrthographicCamera|null} */
    this._camera = null;

    this._viewBounds = null;
    this._sceneDimensions = null;
    this._sceneRect = null;
    this._tempNdc = null;
    this._tempWorld = null;
    this._tempDir = null;

    /** @type {string|null} */
    this._lastFloorKey = null;
  }

  _ensureInit() {
    if (this._material) return;
    const THREE = window.THREE;
    if (!THREE) return;

    this._viewBounds = new THREE.Vector4(0, 0, 1, 1);
    this._sceneDimensions = new THREE.Vector2(1, 1);
    this._sceneRect = new THREE.Vector4(0, 0, 1, 1);
    this._tempNdc = new THREE.Vector3();
    this._tempWorld = new THREE.Vector3();
    this._tempDir = new THREE.Vector3();

    this._material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tMask: { value: null },
        uHasMask: { value: 0.0 },
        uOpacity: { value: 0.35 },
        uMaskFlipY: { value: 0.0 },
        uViewBounds: { value: this._viewBounds },
        uSceneDimensions: { value: this._sceneDimensions },
        uSceneRect: { value: this._sceneRect },
        uHasSceneLayout: { value: 0.0 },
        uDirectScreenUv: { value: 0.0 },
        uReplaceScene: { value: 0.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform sampler2D tMask;
        uniform float uHasMask;
        uniform float uOpacity;
        uniform float uMaskFlipY;
        uniform vec4 uViewBounds;
        uniform vec2 uSceneDimensions;
        uniform vec4 uSceneRect;
        uniform float uHasSceneLayout;
        uniform float uDirectScreenUv;
        uniform float uReplaceScene;

        varying vec2 vUv;

        vec2 screenUvToFoundry(vec2 screenUv) {
          float threeX = mix(uViewBounds.x, uViewBounds.z, screenUv.x);
          float threeY = mix(uViewBounds.y, uViewBounds.w, screenUv.y);
          float foundryY = uSceneDimensions.y - threeY;
          return vec2(threeX, foundryY);
        }

        vec2 foundryToSceneUv(vec2 foundryPos) {
          vec2 sceneOrigin = uSceneRect.xy;
          vec2 sceneSize = uSceneRect.zw;
          return (foundryPos - sceneOrigin) / max(sceneSize, vec2(1e-5));
        }

        void main() {
          vec4 base = texture2D(tDiffuse, vUv);

          if (uHasMask < 0.5) {
            gl_FragColor = base;
            return;
          }

          vec2 rawSceneUv = vUv;
          vec2 maskUv = vUv;
          float inScene = 1.0;
          if (uDirectScreenUv < 0.5 && uHasSceneLayout > 0.5) {
            vec2 foundryPos = screenUvToFoundry(vUv);
            rawSceneUv = foundryToSceneUv(foundryPos);
            inScene =
              step(0.0, rawSceneUv.x) * step(rawSceneUv.x, 1.0) *
              step(0.0, rawSceneUv.y) * step(rawSceneUv.y, 1.0);
            maskUv = clamp(rawSceneUv, vec2(0.0), vec2(1.0));
          }
          if (uMaskFlipY > 0.5) maskUv.y = 1.0 - maskUv.y;

          vec4 m = texture2D(tMask, maskUv);
          float lum = max(m.r, max(m.g, m.b));
          vec3 grey = vec3(lum);
          if (uReplaceScene > 0.5) {
            gl_FragColor = vec4(grey, base.a);
            return;
          }
          float a = clamp(uOpacity, 0.0, 1.0) * inScene;
          vec3 outRgb = mix(base.rgb, grey, a);
          gl_FragColor = vec4(outRgb, base.a);
        }
      `,
      depthWrite: false,
      depthTest: false,
      transparent: false,
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._material);
    this._scene = new THREE.Scene();
    this._scene.add(quad);
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  /**
   * Resolve mask texture for the given mode (extend for future combined masks).
   * @param {string} mode
   * @param {{
   *   resolveOutdoorsMask?: () => { texture: import('three').Texture|null, floorKey?: string|null },
   *   resolveOverheadDebugTexture?: (mode: string) => import('three').Texture|null
   * }} hooks
   * @returns {{
   *   texture: import('three').Texture|null,
   *   floorKey?: string|null,
   *   directScreenUv?: boolean,
   *   replaceScene?: boolean,
   * }}
   */
  resolveMaskTexture(mode, hooks = {}) {
    if (mode === 'outdoors_current' && typeof hooks.resolveOutdoorsMask === 'function') {
      const r = hooks.resolveOutdoorsMask();
      return {
        texture: r?.texture ?? null,
        floorKey: r?.floorKey ?? null,
        directScreenUv: false,
        replaceScene: false,
      };
    }
    if (String(mode).startsWith('overhead_') && typeof hooks.resolveOverheadDebugTexture === 'function') {
      return {
        texture: hooks.resolveOverheadDebugTexture(mode) ?? null,
        floorKey: 'overhead',
        directScreenUv: true,
        replaceScene: true,
      };
    }
    return { texture: null, floorKey: null };
  }

  /**
   * @param {import('three').WebGLRenderer} renderer
   * @param {import('three').WebGLRenderTarget} sourceRT
   * @param {import('three').WebGLRenderTarget} destRT
   * @param {import('three').Texture|null} maskTex
   * @param {number} opacity01
   * @param {import('three').Camera} camera
   * @param {number} [groundZ=0]
   * @param {{directScreenUv?: boolean, replaceScene?: boolean}} [options]
   * @returns {boolean} Whether the pass wrote to destRT
   */
  renderComposite(renderer, sourceRT, destRT, maskTex, opacity01, camera, groundZ = 0, options = {}) {
    const THREE = window.THREE;
    if (!THREE || !renderer || !sourceRT?.texture || !destRT) return false;
    this._ensureInit();
    if (!this._material) return false;
    const directScreenUv = options?.directScreenUv === true;
    const replaceScene = options?.replaceScene === true;

    const u = this._material.uniforms;
    u.tDiffuse.value = sourceRT.texture;
    u.tMask.value = maskTex;
    u.uHasMask.value = maskTex ? 1.0 : 0.0;
    u.uOpacity.value = Math.max(0, Math.min(1, opacity01));
    u.uMaskFlipY.value = maskTex?.flipY ? 1.0 : 0.0;
    u.uReplaceScene.value = replaceScene ? 1.0 : 0.0;
    if (maskTex && THREE.ClampToEdgeWrapping) {
      maskTex.wrapS = THREE.ClampToEdgeWrapping;
      maskTex.wrapT = THREE.ClampToEdgeWrapping;
    }

    try {
      const d = canvas?.dimensions;
      if (d && typeof d.width === 'number' && typeof d.height === 'number') {
        u.uSceneDimensions.value.set(d.width, d.height);
      }
      const sr = d?.sceneRect ?? d?.rect ?? null;
      const sx = Number(sr?.x ?? d?.sceneX ?? 0);
      const sy = Number(sr?.y ?? d?.sceneY ?? 0);
      const sw = Number(sr?.width ?? sr?.w ?? d?.sceneWidth ?? d?.width ?? 0);
      const sh = Number(sr?.height ?? sr?.h ?? d?.sceneHeight ?? d?.height ?? 0);
      if (!directScreenUv && Number.isFinite(sw) && Number.isFinite(sh) && sw >= 1 && sh >= 1) {
        u.uSceneRect.value.set(sx, sy, sw, sh);
        u.uHasSceneLayout.value = 1.0;
        u.uDirectScreenUv.value = 0.0;
      } else {
        u.uHasSceneLayout.value = 0.0;
        u.uDirectScreenUv.value = 1.0;
      }

      updateViewBoundsFromCamera(
        camera,
        groundZ,
        u.uViewBounds.value,
        this._tempNdc,
        this._tempWorld,
        this._tempDir
      );
    } catch (e) {
      u.uHasSceneLayout.value = 0.0;
      u.uDirectScreenUv.value = 1.0;
      log.warn('MaskDebugOverlayPass: layout uniform update failed', e);
    }

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevScissor =
      typeof renderer.getScissorTest === 'function' ? renderer.getScissorTest() : null;

    try {
      if (typeof renderer.setScissorTest === 'function') renderer.setScissorTest(false);
      renderer.setRenderTarget(destRT);
      renderer.autoClear = true;
      if (typeof renderer.setClearColor === 'function') renderer.setClearColor(0x000000, 1);
      if (typeof renderer.clear === 'function') renderer.clear(true, true, true);
      renderer.render(this._scene, this._camera);
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
      if (typeof renderer.setScissorTest === 'function' && prevScissor !== null) {
        try {
          renderer.setScissorTest(prevScissor);
        } catch (_) {
        }
      }
    }

    return true;
  }

  dispose() {
    if (this._material) {
      try {
        this._material.dispose();
      } catch (_) {
      }
      this._material = null;
    }
    this._scene = null;
    this._camera = null;
  }
}
