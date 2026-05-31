/**
 * @fileoverview V2 Window Light Effect — scene-UV compositor masks (PaintedShadow-style).
 *
 * Window glow is sampled from GpuSceneMaskCompositor `_Windows` / `_Structural`
 * masks in Foundry scene UV space (same placement as PaintedShadowEffectV2).
 * Per-floor stacking uses compositor floor-id + per-band mask slots 0–3.
 *
 * Emit pass renders into a scene-UV RT (mask resolution, PaintedShadow-style).
 * Lighting compose samples that texture at sceneUvFoundry so glow stays locked
 * to the map when the camera pans or zooms.
 *
 * @module compositor-v2/effects/WindowLightEffectV2
 */

import { createLogger } from '../../core/log.js';
import { loadAssetBundle, loadTexture, probeMaskFile } from '../../assets/loader.js';
import { getMaskTextureManifest, maskTextureManifestMatchesLoadContext } from '../../settings/mask-manifest-flags.js';
import { resolveCompositorFloorMaskTexture } from '../../masks/resolve-compositor-outdoors.js';
import { getViewedLevelBackgroundSrc } from '../../foundry/levels-scene-flags.js';

const log = createLogger('WindowLightEffectV2');

const WINDOW_MASK_ALIASES = ['windows', 'structural'];

/** Full-screen emit pass — scene-UV RT (PaintedShadow project pass pattern). */
const EMIT_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const EMIT_FRAG = `
  uniform float uEffectEnabled;
  uniform float uDebugForceMagenta;
  uniform float uIntensity;
  uniform float uFalloff;
  uniform vec3 uColor;
  uniform float uForcedFloorIndex;
  uniform float uMaxVisibleFloorIndex;
  uniform sampler2D tWindow0;
  uniform sampler2D tWindow1;
  uniform sampler2D tWindow2;
  uniform sampler2D tWindow3;
  uniform float uHasWindow0;
  uniform float uHasWindow1;
  uniform float uHasWindow2;
  uniform float uHasWindow3;
  uniform float uWindow0FlipY;
  uniform float uWindow1FlipY;
  uniform float uWindow2FlipY;
  uniform float uWindow3FlipY;
  uniform sampler2D tFloorIdTex;
  uniform float uHasFloorIdTex;
  uniform float uFloorIdFlipY;
  varying vec2 vUv;

  void main() {
    if (uEffectEnabled < 0.5) {
      gl_FragColor = vec4(0.0);
      return;
    }

    vec2 sceneUv = clamp(vUv, 0.0, 1.0);
    float floorIdx = 0.0;

    if (uForcedFloorIndex >= 0.0) {
      floorIdx = clamp(uForcedFloorIndex, 0.0, 3.0);
    } else if (uHasFloorIdTex > 0.5) {
      vec2 fidUv = sceneUv;
      if (uFloorIdFlipY > 0.5) fidUv.y = 1.0 - fidUv.y;
      floorIdx = floor(texture2D(tFloorIdTex, fidUv).r * 255.0 + 0.5);
      if (floorIdx < 0.0) floorIdx = 0.0;
      if (uMaxVisibleFloorIndex >= 0.0 && floorIdx > uMaxVisibleFloorIndex + 0.5) {
        gl_FragColor = vec4(0.0);
        return;
      }
    }

    vec4 mask = vec4(0.0);

    if (floorIdx < 0.5) {
      if (uHasWindow0 > 0.5) {
        vec2 suv = sceneUv;
        if (uWindow0FlipY > 0.5) suv.y = 1.0 - suv.y;
        mask = texture2D(tWindow0, suv);
      }
    } else if (floorIdx < 1.5) {
      if (uHasWindow1 > 0.5) {
        vec2 suv = sceneUv;
        if (uWindow1FlipY > 0.5) suv.y = 1.0 - suv.y;
        mask = texture2D(tWindow1, suv);
      }
    } else if (floorIdx < 2.5) {
      if (uHasWindow2 > 0.5) {
        vec2 suv = sceneUv;
        if (uWindow2FlipY > 0.5) suv.y = 1.0 - suv.y;
        mask = texture2D(tWindow2, suv);
      }
    } else if (uHasWindow3 > 0.5) {
      vec2 suv = sceneUv;
      if (uWindow3FlipY > 0.5) suv.y = 1.0 - suv.y;
      mask = texture2D(tWindow3, suv);
    }

    if (mask.a < 0.01) {
      gl_FragColor = vec4(0.0);
      return;
    }

    vec3 shaped = pow(clamp(mask.rgb, 0.0, 1.0), vec3(max(uFalloff, 0.001))) * mask.a;
    float lum = dot(shaped, vec3(0.2126, 0.7152, 0.0722));
    if (lum < 0.001) {
      gl_FragColor = vec4(0.0);
      return;
    }

    vec3 emit = shaped * uColor * uIntensity;
    if (uDebugForceMagenta > 0.5 && dot(emit, emit) > 1e-8) {
      emit = vec3(1.0, 0.0, 1.0);
    }
    gl_FragColor = vec4(emit, 1.0);
  }
`;

function _wlProbeSampleMaskTexture(tex, u, v) {
  const img = tex?.image ?? tex?.source?.data ?? null;
  if (!img) return null;
  const w = img.width ?? img.videoWidth ?? 0;
  const h = img.height ?? img.videoHeight ?? 0;
  if (!(w > 0 && h > 0)) return null;
  const px = Math.max(0, Math.min(w - 1, Math.floor(Math.max(0, Math.min(1, u)) * (w - 1))));
  const py = Math.max(0, Math.min(h - 1, Math.floor(Math.max(0, Math.min(1, v)) * (h - 1))));
  try {
    if (img.data && img.width && img.height) {
      const i = (py * w + px) * 4;
      const r = img.data[i] / 255;
      const g = img.data[i + 1] / 255;
      const b = img.data[i + 2] / 255;
      const a = img.data[i + 3] / 255;
      return { r, g, b, a, luma: 0.2126 * r + 0.7152 * g + 0.0722 * b };
    }
    if (typeof document !== 'undefined') {
      if (!_wlProbeSampleMaskTexture._canvas) {
        _wlProbeSampleMaskTexture._canvas = document.createElement('canvas');
        _wlProbeSampleMaskTexture._ctx = _wlProbeSampleMaskTexture._canvas.getContext('2d', { willReadFrequently: true });
      }
      const c = _wlProbeSampleMaskTexture._canvas;
      const ctx = _wlProbeSampleMaskTexture._ctx;
      if (!ctx) return null;
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      } else {
        ctx.clearRect(0, 0, w, h);
      }
      ctx.drawImage(img, 0, 0, w, h);
      const d = ctx.getImageData(px, py, 1, 1).data;
      const r = d[0] / 255;
      const g = d[1] / 255;
      const b = d[2] / 255;
      const a = d[3] / 255;
      return { r, g, b, a, luma: 0.2126 * r + 0.7152 * g + 0.0722 * b };
    }
  } catch (_) {}
  return null;
}

function _wlProbeCreateRtReadBuffer(rt) {
  const isHalf = rt.texture?.type === window.THREE?.HalfFloatType;
  return isHalf ? new Float32Array(4) : new Uint8Array(4);
}

function _wlProbeDecodeRtChannels(buf, rt) {
  const isHalf = rt.texture?.type === window.THREE?.HalfFloatType;
  if (isHalf) {
    return { r: Math.max(0, buf[0]), g: Math.max(0, buf[1]), b: Math.max(0, buf[2]), a: Math.max(0, buf[3]) };
  }
  return { r: buf[0] / 255, g: buf[1] / 255, b: buf[2] / 255, a: buf[3] / 255 };
}

function _wlProbeScanRtMaxLuma(renderer, rt, gridSize = 8) {
  if (!renderer || !rt?.width || !rt?.height) return null;
  const gs = Math.max(2, Math.min(32, Math.floor(Number(gridSize) || 8)));
  const buf = _wlProbeCreateRtReadBuffer(rt);
  let maxLuma = 0;
  let maxAt = { u: 0, v: 0 };
  let sampleCount = 0;
  for (let gy = 0; gy < gs; gy += 1) {
    for (let gx = 0; gx < gs; gx += 1) {
      const u = (gx + 0.5) / gs;
      const v = (gy + 0.5) / gs;
      const px = Math.max(0, Math.min(rt.width - 1, Math.floor(u * (rt.width - 1))));
      const py = Math.max(0, Math.min(rt.height - 1, rt.height - 1 - Math.floor(v * (rt.height - 1))));
      try {
        renderer.readRenderTargetPixels(rt, px, py, 1, 1, buf);
        const { r, g, b } = _wlProbeDecodeRtChannels(buf, rt);
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        sampleCount += 1;
        if (luma > maxLuma) {
          maxLuma = luma;
          maxAt = { u, v };
        }
      } catch (_) {}
    }
  }
  return { maxLuma, maxAt, gridSize: gs, sampleCount };
}

function _wlProbeSampleRtPixel(renderer, rt, u, v) {
  if (!renderer || !rt?.width || !rt?.height) return null;
  const px = Math.max(0, Math.min(rt.width - 1, Math.floor(Math.max(0, Math.min(1, u)) * (rt.width - 1))));
  const py = Math.max(0, Math.min(rt.height - 1, Math.floor(Math.max(0, Math.min(1, v)) * (rt.height - 1))));
  const buf = _wlProbeCreateRtReadBuffer(rt);
  try {
    renderer.readRenderTargetPixels(rt, px, py, 1, 1, buf);
    const { r, g, b, a } = _wlProbeDecodeRtChannels(buf, rt);
    return { r, g, b, a, luma: 0.2126 * r + 0.7152 * g + 0.0722 * b, px, py };
  } catch (_) {
    return null;
  }
}

function _worldToSceneUvFoundry(wx, wy) {
  const dims = canvas?.dimensions;
  if (!dims) return null;
  const sr = dims.sceneRect ?? dims;
  const sceneX = Number(sr.x ?? 0);
  const sceneY = Number(sr.y ?? 0);
  const sceneW = Number(sr.width ?? dims.sceneWidth ?? dims.width ?? 1);
  const sceneH = Number(sr.height ?? dims.sceneHeight ?? dims.height ?? 1);
  const canvasH = Number(dims.height ?? 1);
  const foundryY = canvasH - wy;
  return {
    u: (wx - sceneX) / Math.max(1e-5, sceneW),
    v: 1.0 - (foundryY - sceneY) / Math.max(1e-5, sceneH),
  };
}

export class WindowLightEffectV2 {
  constructor() {
    this._enabled = true;
    this._initialized = false;
    this._scene = null;
    this._drawCamera = null;
    this._emitMaterial = null;
    this._activeFloorIndex = 0;
    this._renderFloorIndex = null;
    this._renderFloorSliceStrict = false;
    this._debugForceMagenta = false;
    this._lastDrawStats = null;
    this._lastFoundrySceneData = null;
    /** Scene-UV emit RT (matches compositor mask dimensions — PaintedShadow-style). */
    this._emitRT = null;
    this._emitRtSig = '';
    /** Legacy diagnostics shim — one entry per compositor floor slot with a mask. */
    this._overlays = new Map();
    /** @type {(import('three').Texture|null)[]} Compositor slots (raw). */
    this._windowMasks = [null, null, null, null];
    /** @type {(import('three').Texture|null)[]} Distinct per-floor masks for draw (PaintedShadow-style). */
    this._litWindowMasks = [null, null, null, null];
    /** @type {Map<string, import('three').Texture|null>} */
    this._windowBundleByBasePath = new Map();
    /** @type {Set<string>} */
    this._windowBundleLoadsInFlight = new Set();
    /** @type {Set<string>} */
    this._windowBundleMissPaths = new Set();
    /** @type {Map<string, number>} */
    this._windowBundleLastAttemptMs = new Map();
    /** @type {import('three').Texture|null} */
    this._floorIdTex = null;
    /** @type {import('three').Texture|null} 1×1 black — unbound sampler slots must never stay null. */
    this._fallbackMaskTex = null;

    this.params = {
      hasWindowMask: false,
      enabled: true,
      intensity: 4.0,
      falloff: 1.5,
      color: { r: 1.0, g: 0.96, b: 0.85 },
    };

    log.debug('WindowLightEffectV2 created (scene-UV compositor)');
  }

  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    this.params.enabled = this._enabled;
    if (this._emitMaterial?.uniforms?.uEffectEnabled) {
      this._emitMaterial.uniforms.uEffectEnabled.value = this._enabled ? 1.0 : 0.0;
    }
  }

  static getControlSchema() {
    return {
      enabled: true,
      help: {
        title: 'Window Light',
        summary: 'Emissive window glow from GpuSceneMaskCompositor _Windows masks (scene UV, per-floor stack).',
      },
      groups: [
        { name: 'status', label: 'Effect Status', type: 'inline', advanced: true, parameters: ['textureStatus'] },
        { name: 'lighting', label: 'Window Light', type: 'folder', expanded: true, parameters: ['intensity', 'falloff', 'color'] },
      ],
      parameters: {
        hasWindowMask: { type: 'boolean', default: true, hidden: true },
        textureStatus: { type: 'string', label: 'Mask Status', default: 'Checking...', readonly: true },
        intensity: {
          type: 'slider',
          label: 'Intensity',
          min: 0.0,
          max: 12.0,
          step: 0.05,
          default: 4.0,
          tooltip: 'Linear window glow energy written to the window-light RT.',
        },
        falloff: { type: 'slider', label: 'Falloff (Gamma)', min: 0.5, max: 5.0, step: 0.05, default: 1.5 },
        color: { type: 'color', label: 'Light Color', default: { r: 1.0, g: 0.96, b: 0.85 } },
      },
    };
  }

  getEffectiveIntensity() {
    return Math.max(0.0, Number(this.params.intensity) || 0);
  }

  initialize() {
    if (this._initialized) return;
    const THREE = window.THREE;
    if (!THREE) { log.warn('initialize: THREE not available'); return; }

    this._scene = new THREE.Scene();
    this._scene.name = 'WindowLightScene';
    this._drawCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._ensureFallbackTextures(THREE);
    const fb = this._fallbackMaskTex;
    this._buildSceneUvEmitPass(fb);

    this._scene.userData.onBindWindowLightPass = (_rw, _rh, _renderCamera) => {};

    this._scene.userData.onAfterWindowLightPass = () => {};

    this._scene.userData.drawWindowLightPass = (renderer, camera) => {
      this.drawWindowLightPass(renderer, camera);
    };

    this._scene.userData.getWindowLightTexture = () => this.getEmitTexture();

    this._initialized = true;
    log.info('WindowLightEffectV2 initialized (scene-UV compositor)');
  }

  clear() {}

  dispose() {
    if (this._scene?.userData) {
      delete this._scene.userData.onBindWindowLightPass;
      delete this._scene.userData.onAfterWindowLightPass;
      delete this._scene.userData.drawWindowLightPass;
      delete this._scene.userData.getWindowLightTexture;
    }
    try { this._emitMaterial?.dispose(); } catch (_) {}
    try { this._emitRT?.dispose(); } catch (_) {}
    try { this._scene?.children?.[0]?.geometry?.dispose(); } catch (_) {}
    try { this._fallbackMaskTex?.dispose(); } catch (_) {}
    this._emitMaterial = null;
    this._emitRT = null;
    this._drawCamera = null;
    this._fallbackMaskTex = null;
    this._scene = null;
    this._initialized = false;
    this._windowMasks = [null, null, null, null];
    this._litWindowMasks = [null, null, null, null];
    this._windowBundleByBasePath.clear();
    this._windowBundleLoadsInFlight.clear();
    this._windowBundleMissPaths.clear();
    this._windowBundleLastAttemptMs.clear();
    this._floorIdTex = null;
    this._overlays.clear();
  }

  onFloorChange(maxFloorIndex) {
    const prev = this._activeFloorIndex;
    this._activeFloorIndex = Number.isFinite(Number(maxFloorIndex)) ? Number(maxFloorIndex) : 0;
    if (prev !== this._activeFloorIndex) {
      log.info(`WindowLightEffectV2 floor visibility: ${prev} -> ${this._activeFloorIndex}`);
    }
  }

  setRenderFloorIndex(floorIndex = null, sliceStrict = false) {
    const next = (floorIndex !== null && floorIndex !== undefined) ? Number(floorIndex) : null;
    this._renderFloorIndex = (next !== null && Number.isFinite(next)) ? next : null;
    this._renderFloorSliceStrict = this._renderFloorIndex !== null ? !!sliceStrict : false;
  }

  async populate(foundrySceneData) {
    if (!this._initialized) { log.warn('populate: not initialized'); return; }
    this._lastFoundrySceneData = foundrySceneData;
    this._primeWindowBundleLoadsForAllFloors();
    this.syncFrameOcclusion(null);
    const slotCount = this._windowMasks.filter(Boolean).length;
    log.info(`WindowLightEffectV2 populated: compositor window slots=${slotCount}`);
  }

  update(_timeInfo) {
    if (!this._initialized || !this._enabled) return;

    const polledActiveFloor = Number(window.MapShine?.floorStack?.getActiveFloor?.()?.index);
    if (Number.isFinite(polledActiveFloor) && polledActiveFloor !== this._activeFloorIndex) {
      this.onFloorChange(polledActiveFloor);
    }

    const u = this._emitMaterial?.uniforms;
    if (!u) return;

    u.uEffectEnabled.value = this._enabled ? 1.0 : 0.0;
    u.uDebugForceMagenta.value = this._debugForceMagenta ? 1.0 : 0.0;
    u.uIntensity.value = this.getEffectiveIntensity();
    u.uFalloff.value = Math.max(0.01, Number(this.params.falloff) || 1);

    const c = this.params.color;
    if (c && typeof c === 'object') {
      u.uColor.value.setRGB(Number(c.r) || 0, Number(c.g) || 0, Number(c.b) || 0);
    }
  }

  render(_renderer, _camera) {}

  // ── FloorCompositor hooks ───────────────────────────────────────────────────

  setOutdoorsMask(_mask) {}
  setCloudShadowTexture(_tex, _w, _h, _bounds) {}
  setOverheadRoofAlphaTexture(_tex, _w, _h) {}
  setCeilingTransmittanceTexture(_tex) {}
  setSkyState(_state) {}
  setTimelineGradeState(_state) {}
  setDriver(_driverState) {}
  applyOutdoorsClip(_renderer, _camera, _targetRT, _outdoorsMaskOverride) {}

  applyPostFilterBoost(_renderer, _baseRT, _outputRT, _windowTex, _gain = 1.0) {
    return false;
  }

  /**
   * Refresh per-floor window mask slots from GpuSceneMaskCompositor (PaintedShadow-style).
   * @param {*} _floorCompositor
   */
  syncFrameOcclusion(_floorCompositor) {
    const compositor = window.MapShine?.sceneComposer?._sceneMaskCompositor ?? null;
    this._windowMasks = [null, null, null, null];
    this._litWindowMasks = [null, null, null, null];
    this._floorIdTex = null;
    this.params.hasWindowMask = false;

    if (!compositor) return;

    try {
      const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
      this._primeWindowBundleLoadsForAllFloors();
      for (const floor of floors) {
        const idx = Number(floor?.index);
        if (!Number.isFinite(idx) || idx < 0 || idx > 3) continue;
        this._windowMasks[idx] = this._resolveCompositorWindowMaskForFloor(floor, compositor);
        if (!this._windowMasks[idx]) {
          this._tryAssignWindowBundleMaskForFloor(idx);
        }
      }

      const groundMask = this._windowMasks[0] ?? null;
      for (let idx = 1; idx < 4; idx += 1) {
        const tex = this._windowMasks[idx];
        if (!tex || !groundMask?.uuid || tex.uuid !== groundMask.uuid) continue;
        const replaced = this._tryAssignWindowBundleMaskForFloor(idx, groundMask.uuid);
        if (!replaced) this._windowMasks[idx] = null;
      }

      this._rebuildLitWindowMasks();

      if (this._litWindowMasks.some((_t, i) => this._hasValidWindowMask(i))) {
        this._floorIdTex = compositor.floorIdTarget?.texture ?? null;
        this.params.hasWindowMask = true;
      }
      this._emitRtSig = '';
      this._refreshOverlayShim();
    } catch (err) {
      log.warn('syncFrameOcclusion failed:', err);
    }
  }

  setDebugForceMagenta(enabled = true) {
    this._debugForceMagenta = enabled === true;
    const u = this._emitMaterial?.uniforms?.uDebugForceMagenta;
    if (u) u.value = this._debugForceMagenta ? 1.0 : 0.0;
    return this._debugForceMagenta;
  }

  /** Scene-UV window glow texture for compose / shadow lift. */
  getEmitTexture() {
    return this._emitRT?.texture ?? null;
  }

  getRenderTargetDiagnostics(renderer = null, lightingEffect = null, options = {}) {
    const r = renderer ?? globalThis.MapShine?.renderer ?? null;
    const rt = this._emitRT
      ?? lightingEffect?._windowLightRT
      ?? globalThis.MapShine?.effectComposer?._floorCompositorV2?._lightingEffect?._windowLightRT
      ?? null;

    const scan = (rt && r) ? _wlProbeScanRtMaxLuma(r, rt, 8) : null;
    const screenUv = options?.screenUv ?? null;
    let rtAtClick = null;
    if (rt && r && screenUv && Number.isFinite(screenUv.u) && Number.isFinite(screenUv.v)) {
      rtAtClick = _wlProbeSampleRtPixel(r, rt, screenUv.u, screenUv.v);
    }

    return {
      rtWidth: rt?.width ?? null,
      rtHeight: rt?.height ?? null,
      rtMaxLuma: scan?.maxLuma ?? null,
      rtMaxAt: scan?.maxAt ?? null,
      rtAtClick,
      compositorWindowSlots: this._windowMasks.map((t, i) => (t ? i : null)).filter((x) => x !== null),
      litWindowSlots: this._litWindowMasks.map((t, i) => (this._hasValidWindowMask(i) ? i : null)).filter((x) => x !== null),
      hasFloorIdTex: !!this._floorIdTex,
      renderFloorIndex: Number.isFinite(this._renderFloorIndex) ? this._renderFloorIndex : null,
      lastDrawStats: this._lastDrawStats ? { ...this._lastDrawStats } : null,
      debugForceMagenta: !!this._debugForceMagenta,
    };
  }

  probeAtWorld(wx, wy, options = {}) {
    const wxN = Number(wx);
    const wyN = Number(wy);
    const out = {
      worldX: wxN,
      worldY: wyN,
      enabled: !!this._enabled && !!this.params?.enabled,
      initialized: !!this._initialized,
      compositorSlots: this._windowMasks.map((t, i) => (t ? i : null)).filter((x) => x !== null),
      litWindowSlots: this._litWindowMasks.map((_t, i) => (this._hasValidWindowMask(i) ? i : null)).filter((x) => x !== null),
      runtime: {},
      blockers: [],
      hints: [],
      verdict: 'unknown',
    };

    if (!Number.isFinite(wxN) || !Number.isFinite(wyN)) {
      out.error = 'invalid-coordinates';
      out.verdict = 'invalid';
      return out;
    }
    if (!this._initialized) {
      out.blockers.push('effect_not_initialized');
      out.verdict = 'no_light';
      return out;
    }
    if (!this._enabled || !this.params?.enabled) {
      out.blockers.push('effect_disabled');
      out.verdict = 'no_light';
    }
    if (!this.params.hasWindowMask) {
      out.blockers.push('no_compositor_window_masks');
    }

    const sceneUv = _worldToSceneUvFoundry(wxN, wyN);
    out.sceneUv = sceneUv;

    let bestSample = null;
    let bestFloor = null;
    if (sceneUv) {
      for (let fi = 0; fi < 4; fi += 1) {
        if (!this._hasValidWindowMask(fi)) continue;
        const tex = this._litWindowMasks[fi];
        if (!tex) continue;
        const flipY = tex.flipY ? 1 : 0;
        const su = sceneUv.u;
        let sv = sceneUv.v;
        if (flipY) sv = 1.0 - sv;
        const sample = _wlProbeSampleMaskTexture(tex, su, sv);
        if (sample && sample.luma > (bestSample?.luma ?? 0)) {
          bestSample = sample;
          bestFloor = fi;
        }
      }
    }

    out.maskSample = bestSample;
    out.floorIndex = bestFloor;
    if (bestSample && bestSample.a >= 0.01 && bestSample.luma > 0.001) {
      out.verdict = 'would_emit';
      out.hints.push('Compositor mask would emit — check _windowLightRT or debug magenta.');
    } else if (!this.params.hasWindowMask) {
      out.verdict = 'no_light';
    } else {
      out.verdict = 'no_light';
      out.blockers.push('no_mask_energy_at_world');
    }

    const ms = globalThis.MapShine ?? {};
    out.renderDiagnostics = this.getRenderTargetDiagnostics(ms.renderer ?? null, null, options);
    return out;
  }

  getPipelineStatus() {
    const fc = globalThis.MapShine?.effectComposer?._floorCompositorV2 ?? null;
    const le = fc?._lightingEffect ?? null;
    return {
      enabled: !!this._enabled && this.params?.enabled !== false,
      initialized: !!this._initialized,
      hasWindowMask: !!this.params?.hasWindowMask,
      compositorWindowSlots: this._windowMasks.map((t, i) => (t ? i : null)).filter((x) => x !== null),
      litWindowSlots: this._litWindowMasks.map((_t, i) => (this._hasValidWindowMask(i) ? i : null)).filter((x) => x !== null),
      hasFloorIdTex: !!this._floorIdTex,
      activeFloorIndex: this._activeFloorIndex,
      renderFloorIndex: this._renderFloorIndex,
      renderFloorSliceStrict: this._renderFloorSliceStrict,
      emitRtSize: this._emitRT
        ? { w: this._emitRT.width, h: this._emitRT.height }
        : null,
      lastDrawStats: this._lastDrawStats,
      lightingEnabled: le?.enabled !== false && le?.params?.enabled !== false,
      windowLightRtSize: this._emitRT
        ? { w: this._emitRT.width, h: this._emitRT.height }
        : null,
      winScenePassedToLighting: !!(fc && this._scene && this._enabled),
    };
  }

  drawWindowLightPass(renderer, _camera) {
    if (!this._enabled || !renderer || !this._initialized || !this._scene || !this._emitMaterial) {
      this._lastDrawStats = { skipReason: 'disabled_or_unready' };
      return;
    }

    if (!this.params.hasWindowMask) {
      this._lastDrawStats = { skipReason: 'no_compositor_masks', drew: false };
      return;
    }

    this._rebuildLitWindowMasks();

    const strictFloor = Number(this._renderFloorIndex);
    if (this._renderFloorSliceStrict && Number.isFinite(strictFloor)) {
      const fi = Math.max(0, Math.min(3, Math.floor(strictFloor)));
      if (!this._hasValidWindowMask(fi)) {
        const THREE = window.THREE;
        if (THREE && this._ensureEmitTarget(THREE, renderer)) {
          const prevTarget = renderer.getRenderTarget();
          const drawState = this._prepareWindowLightDrawState(renderer, this._emitRT);
          try {
            renderer.setRenderTarget(this._emitRT);
            renderer.clear(true, true, false);
          } finally {
            renderer.setRenderTarget(prevTarget);
            this._restoreWindowLightDrawState(renderer, drawState);
          }
        }
        this._lastDrawStats = {
          skipReason: 'no_lit_window_mask_for_floor',
          floor: fi,
          drew: false,
          clearedEmitRt: true,
        };
        return;
      }
    }

    const THREE = window.THREE;
    if (!THREE || !this._ensureEmitTarget(THREE, renderer)) {
      this._lastDrawStats = { skipReason: 'emit_rt_unready', drew: false };
      return;
    }

    this._bindCompositorMaskUniforms();
    this._bindFloorSliceUniforms();

    const stats = {
      path: 'sceneUvEmitRt',
      floorSlots: this._windowMasks.map((t, i) => (t ? i : null)).filter((x) => x !== null),
      litWindowSlots: this._litWindowMasks.map((_t, i) => (this._hasValidWindowMask(i) ? i : null)).filter((x) => x !== null),
      hasFloorId: !!this._floorIdTex,
      emitRt: { w: this._emitRT.width, h: this._emitRT.height },
    };

    const prevTarget = renderer.getRenderTarget();
    const drawState = this._prepareWindowLightDrawState(renderer, this._emitRT);

    try {
      renderer.setRenderTarget(this._emitRT);
      renderer.render(this._scene, this._drawCamera);
      stats.drew = true;
    } finally {
      renderer.setRenderTarget(prevTarget);
      this._restoreWindowLightDrawState(renderer, drawState);
      this._lastDrawStats = stats;
    }
  }

  _buildSceneUvEmitPass(fallbackTex = null) {
    const THREE = window.THREE;
    const fb = fallbackTex ?? this._fallbackMaskTex ?? null;
    const c = this.params.color;
    const cr = (c && typeof c === 'object') ? (Number(c.r) || 1) : 1;
    const cg = (c && typeof c === 'object') ? (Number(c.g) || 0.96) : 0.96;
    const cb = (c && typeof c === 'object') ? (Number(c.b) || 0.85) : 0.85;

    this._emitMaterial = new THREE.ShaderMaterial({
      name: 'MapShineWindowLightEmit',
      uniforms: {
        uEffectEnabled: { value: this._enabled ? 1.0 : 0.0 },
        uDebugForceMagenta: { value: 0.0 },
        uIntensity: { value: Math.max(0.0, Number(this.params.intensity) || 0) },
        uFalloff: { value: Math.max(0.01, Number(this.params.falloff) || 1) },
        uColor: { value: new THREE.Color(cr, cg, cb) },
        uForcedFloorIndex: { value: -1.0 },
        uMaxVisibleFloorIndex: { value: -1.0 },
        tWindow0: { value: fb },
        tWindow1: { value: fb },
        tWindow2: { value: fb },
        tWindow3: { value: fb },
        uHasWindow0: { value: 0.0 },
        uHasWindow1: { value: 0.0 },
        uHasWindow2: { value: 0.0 },
        uHasWindow3: { value: 0.0 },
        uWindow0FlipY: { value: 0.0 },
        uWindow1FlipY: { value: 0.0 },
        uWindow2FlipY: { value: 0.0 },
        uWindow3FlipY: { value: 0.0 },
        tFloorIdTex: { value: fb },
        uHasFloorIdTex: { value: 0.0 },
        uFloorIdFlipY: { value: 1.0 },
      },
      vertexShader: EMIT_VERT,
      fragmentShader: EMIT_FRAG,
      toneMapped: false,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.NoBlending,
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._emitMaterial);
    quad.frustumCulled = false;
    this._scene.add(quad);
  }

  _maskImageSize(tex) {
    const img = tex?.image ?? tex?.source?.data ?? null;
    return {
      w: Math.max(1, Number(img?.width) || 1),
      h: Math.max(1, Number(img?.height) || 1),
    };
  }

  _resolveEmitMaskReference() {
    return this._litWindowMasks.find((_t, i) => this._hasValidWindowMask(i))
      ?? this._windowMasks.find((t) => !!t)
      ?? this._fallbackMaskTex
      ?? null;
  }

  _ensureEmitTarget(THREE, _renderer) {
    const maskTex = this._resolveEmitMaskReference();
    if (!maskTex) return false;

    const { w, h } = this._maskImageSize(maskTex);
    const sig = `${w}x${h}|${maskTex.uuid ?? ''}`;
    if (this._emitRT && this._emitRtSig === sig) return true;

    const le = window.MapShine?.effectComposer?._floorCompositorV2?._lightingEffect ?? null;
    const useHalf = le?.params?.windowLightUseHalfFloat !== false;
    const rtOpts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: useHalf ? THREE.HalfFloatType : THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    };

    if (!this._emitRT) {
      this._emitRT = new THREE.WebGLRenderTarget(w, h, rtOpts);
      this._emitRT.texture.colorSpace = THREE.LinearSRGBColorSpace;
    } else {
      this._emitRT.setSize(w, h);
    }
    this._emitRtSig = sig;
    return true;
  }

  _ensureFallbackTextures(THREE) {
    if (this._fallbackMaskTex) return;
    try {
      const data = new Uint8Array([0, 0, 0, 0]);
      this._fallbackMaskTex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
      this._fallbackMaskTex.needsUpdate = true;
      this._fallbackMaskTex.flipY = false;
      this._fallbackMaskTex.generateMipmaps = false;
      this._fallbackMaskTex.minFilter = THREE.NearestFilter;
      this._fallbackMaskTex.magFilter = THREE.NearestFilter;
      this._fallbackMaskTex.name = 'MapShineWindowLightMaskFallback';
    } catch (err) {
      log.warn('_ensureFallbackTextures failed:', err);
      this._fallbackMaskTex = null;
    }
  }

  _refreshOverlayShim() {
    this._overlays.clear();
    for (let i = 0; i < 4; i += 1) {
      if (this._hasValidWindowMask(i)) {
        this._overlays.set(`__compositor_floor_${i}__`, { floorIndex: i });
      }
    }
  }

  _levelContextForFloorIndex(floorIndex) {
    try {
      const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
      const floor = floors.find((f) => Number(f?.index) === Number(floorIndex)) ?? null;
      if (!floor) return window.MapShine?.activeLevelContext ?? null;
      const bottom = Number(floor.elevationMin);
      const top = Number(floor.elevationMax);
      if (!Number.isFinite(bottom)) return window.MapShine?.activeLevelContext ?? null;
      return { bottom, top: Number.isFinite(top) ? top : undefined };
    } catch (_) {
      return window.MapShine?.activeLevelContext ?? null;
    }
  }

  _resolveCompositorWindowMaskForFloor(floor, compositor) {
    const key = floor?.compositorKey;
    const idx = Number(floor?.index);
    if (!compositor || !key) return null;

    const lvlCtx = this._levelContextForFloorIndex(idx);
    const gpu = resolveCompositorFloorMaskTexture(compositor, WINDOW_MASK_ALIASES, lvlCtx);
    if (gpu?.texture) return gpu.texture;

    return compositor.getFloorTexture?.(key, 'windows')
      ?? compositor.getFloorTexture?.(key, 'structural')
      ?? null;
  }

  _resolveBasePathForFloorIndex(floorIndex) {
    try {
      const sc = window.MapShine?.sceneComposer ?? null;
      const scene = canvas?.scene ?? null;
      if (!sc || !scene || typeof sc.extractBasePath !== 'function') return null;
      const levels = scene?.levels?.sorted ?? scene?.levels?.contents ?? [];
      const target = levels.find((l) => Number(l?.index) === Number(floorIndex)) ?? null;
      const bgSrc = target?.background?.src ?? null;
      if (typeof bgSrc !== 'string' || !bgSrc.trim()) return null;
      const bp = sc.extractBasePath(bgSrc.trim());
      return (typeof bp === 'string' && bp.trim()) ? bp.trim() : null;
    } catch (_) {
      return null;
    }
  }

  _resolveViewedLevelWindowProbeInfo() {
    try {
      const scene = canvas?.scene ?? null;
      const viewedSrc = getViewedLevelBackgroundSrc(scene);
      const ext = (() => {
        const s = String(viewedSrc || '');
        const noQuery = s.split('?')[0];
        const dot = noQuery.lastIndexOf('.');
        return dot >= 0 ? noQuery.slice(dot + 1).toLowerCase() : 'webp';
      })();
      return { viewedSrc: viewedSrc || null, ext: ext || 'webp' };
    } catch (_) {
      return { viewedSrc: null, ext: 'webp' };
    }
  }

  _resolveWindowProbeInfoForFloorIndex(floorIndex) {
    try {
      const scene = canvas?.scene ?? null;
      const levels = scene?.levels?.sorted ?? scene?.levels?.contents ?? [];
      const target = levels.find((l) => Number(l?.index) === Number(floorIndex)) ?? null;
      const bgSrc = target?.background?.src ?? null;
      if (typeof bgSrc !== 'string' || !bgSrc.trim()) {
        return this._resolveViewedLevelWindowProbeInfo();
      }
      const s = bgSrc.trim();
      const noQuery = s.split('?')[0];
      const dot = noQuery.lastIndexOf('.');
      const ext = dot >= 0 ? noQuery.slice(dot + 1).toLowerCase() : 'webp';
      return { viewedSrc: s, ext: ext || 'webp' };
    } catch (_) {
      return this._resolveViewedLevelWindowProbeInfo();
    }
  }

  async _probeWindowMaskTextureForBasePath(basePath, floorIndex = null) {
    if (!basePath) return null;
    const info = Number.isFinite(Number(floorIndex))
      ? this._resolveWindowProbeInfoForFloorIndex(Number(floorIndex))
      : this._resolveViewedLevelWindowProbeInfo();

    try {
      const scene = canvas?.scene ?? null;
      const flag = getMaskTextureManifest(scene);
      const maskSourceSrc = info.viewedSrc ?? null;
      if (flag && maskTextureManifestMatchesLoadContext(flag, basePath, maskSourceSrc)) {
        for (const key of ['windows', 'structural']) {
          const p = flag?.pathsByMaskId?.[key] ?? null;
          if (typeof p === 'string' && p.trim()) {
            const tex = await loadTexture(p.trim(), { suppressProbeErrors: true });
            if (tex) return tex;
          }
        }
      }
    } catch (_) {}

    const suffixes = ['_Windows', '_Structural', '_windows', '_structural'];
    for (const suffix of suffixes) {
      const probed = await probeMaskFile(basePath, suffix, { allowConventionProbe: false });
      const resolvedPath = probed?.path ?? null;
      if (!resolvedPath) continue;
      try {
        const tex = await loadTexture(resolvedPath, { suppressProbeErrors: true });
        if (tex) return tex;
      } catch (_) {}
    }
    return null;
  }

  /**
   * Load per-level `_Windows` / `_Structural` when compositor slot is empty or ground-duplicated.
   * @param {number} floorIndex
   * @param {string} [groundMaskUuid]
   * @returns {boolean}
   * @private
   */
  _tryAssignWindowBundleMaskForFloor(floorIndex, groundMaskUuid = null) {
    const idx = Number(floorIndex);
    if (!Number.isFinite(idx) || idx < 0 || idx > 3) return false;
    const floorBasePath = this._resolveBasePathForFloorIndex(idx);
    if (!floorBasePath) return false;
    const cached = this._windowBundleByBasePath.get(floorBasePath) ?? null;
    if (!this._windowBundleByBasePath.has(floorBasePath) || cached == null) {
      this._scheduleWindowBundleLoadForBasePath(floorBasePath, idx);
    }
    if (!cached?.uuid) return false;
    if (groundMaskUuid && cached.uuid === groundMaskUuid) return false;
    this._windowMasks[idx] = cached;
    return true;
  }

  /** @private */
  _rebuildLitWindowMasks() {
    const groundUuid = this._windowMasks[0]?.uuid ?? null;
    this._litWindowMasks = [null, null, null, null];
    for (let idx = 0; idx < 4; idx += 1) {
      if (idx === 0) {
        this._litWindowMasks[0] = this._windowMasks[0] ?? null;
        continue;
      }
      const bundleMask = this._getDistinctBundleMaskForFloor(idx, groundUuid);
      if (bundleMask) {
        this._litWindowMasks[idx] = bundleMask;
        continue;
      }
      const compositorMask = this._windowMasks[idx] ?? null;
      if (compositorMask?.uuid && compositorMask.uuid !== groundUuid) {
        this._litWindowMasks[idx] = compositorMask;
        continue;
      }
      this._litWindowMasks[idx] = null;
    }
  }

  /**
   * @param {number} floorIndex
   * @param {string|null} groundMaskUuid
   * @returns {import('three').Texture|null}
   * @private
   */
  _getDistinctBundleMaskForFloor(floorIndex, groundMaskUuid) {
    const floorBasePath = this._resolveBasePathForFloorIndex(floorIndex);
    if (!floorBasePath) return null;
    const cached = this._windowBundleByBasePath.get(floorBasePath) ?? null;
    if (cached?.uuid && (!groundMaskUuid || cached.uuid !== groundMaskUuid)) {
      return cached;
    }
    if (!this._windowBundleByBasePath.has(floorBasePath) || cached == null) {
      this._scheduleWindowBundleLoadForBasePath(floorBasePath, floorIndex);
    }
    return null;
  }

  /** @private */
  _primeWindowBundleLoadsForAllFloors() {
    for (let idx = 1; idx < 4; idx += 1) {
      const floorBasePath = this._resolveBasePathForFloorIndex(idx);
      if (floorBasePath) this._scheduleWindowBundleLoadForBasePath(floorBasePath, idx);
    }
  }

  _scheduleWindowBundleLoadForBasePath(basePath, floorIndex = null) {
    if (!basePath || this._windowBundleLoadsInFlight.has(basePath)) return;
    if (this._windowBundleMissPaths.has(basePath)) return;
    const now = Date.now();
    const last = Number(this._windowBundleLastAttemptMs.get(basePath) ?? 0);
    if (last > 0 && (now - last) < 1200) return;
    this._windowBundleLastAttemptMs.set(basePath, now);
    this._windowBundleLoadsInFlight.add(basePath);
    const run = async () => {
      try {
        const directTex = await this._probeWindowMaskTextureForBasePath(basePath, floorIndex);
        if (directTex) {
          this._windowBundleByBasePath.set(basePath, directTex);
          return;
        }
        const result = await loadAssetBundle(basePath, null, {
          skipBaseTexture: true,
          suppressProbeErrors: true,
          bypassCache: true,
          maskIds: ['windows', 'structural'],
          allowConventionProbe: true,
          maskConventionFallback: 'full',
        });
        const masks = result?.bundle?.masks ?? [];
        const hit = Array.isArray(masks)
          ? masks.find((m) => {
            const id = String(m?.id ?? m?.type ?? '').toLowerCase();
            const suffix = String(m?.suffix ?? '').toLowerCase();
            return id.includes('window') || id.includes('structural')
              || suffix === '_windows' || suffix === '_structural';
          })
          : null;
        const bundleTex = hit?.texture ?? null;
        this._windowBundleByBasePath.set(basePath, bundleTex);
        if (!bundleTex) this._windowBundleMissPaths.add(basePath);
      } catch (_) {
        this._windowBundleByBasePath.set(basePath, null);
        this._windowBundleMissPaths.add(basePath);
      } finally {
        this._windowBundleLoadsInFlight.delete(basePath);
      }
    };
    void run();
  }

  /**
   * @param {number} floorIndex
   * @returns {boolean}
   * @private
   */
  _hasValidWindowMask(floorIndex) {
    const idx = Number(floorIndex);
    if (!Number.isFinite(idx) || idx < 0 || idx > 3) return false;
    const mask = this._litWindowMasks?.[idx] ?? null;
    const fb = this._fallbackMaskTex;
    if (!mask) return false;
    if (!fb) return true;
    return mask !== fb && mask.uuid !== fb.uuid;
  }

  _bindCompositorMaskUniforms() {
    const u = this._emitMaterial?.uniforms;
    if (!u) return;

    const fallback = this._fallbackMaskTex ?? null;

    for (let i = 0; i < 4; i += 1) {
      const valid = this._hasValidWindowMask(i);
      const tex = valid ? (this._litWindowMasks[i] ?? fallback) : fallback;
      u[`tWindow${i}`].value = tex ?? fallback;
      u[`uHasWindow${i}`].value = valid ? 1.0 : 0.0;
      u[`uWindow${i}FlipY`].value = (valid && this._litWindowMasks[i]?.flipY) ? 1.0 : 0.0;
    }

    u.tFloorIdTex.value = this._floorIdTex ?? fallback;
    u.uHasFloorIdTex.value = this._floorIdTex ? 1.0 : 0.0;
    u.uFloorIdFlipY.value = 1.0;
  }

  _bindFloorSliceUniforms() {
    const u = this._emitMaterial?.uniforms;
    if (!u) return;

    const renderFloor = Number(this._renderFloorIndex);
    if (Number.isFinite(renderFloor)) {
      if (this._renderFloorSliceStrict) {
        u.uForcedFloorIndex.value = Math.max(0, Math.min(3, renderFloor));
        u.uMaxVisibleFloorIndex.value = -1.0;
      } else {
        u.uForcedFloorIndex.value = -1.0;
        u.uMaxVisibleFloorIndex.value = Math.max(0, Math.min(3, renderFloor));
      }
    } else {
      u.uForcedFloorIndex.value = -1.0;
      u.uMaxVisibleFloorIndex.value = -1.0;
    }
  }

  _prepareWindowLightDrawState(renderer, rt) {
    const THREE = window.THREE;
    const prev = {
      viewport: null,
      scissorTest: renderer.getScissorTest?.() ?? false,
      autoClear: renderer.autoClear,
      clearColor: null,
      clearAlpha: null,
    };
    if (THREE?.Vector4 && typeof renderer.getViewport === 'function') {
      prev.viewport = new THREE.Vector4();
      renderer.getViewport(prev.viewport);
    }
    if (typeof renderer.getClearColor === 'function') {
      prev.clearColor = new THREE.Color();
      renderer.getClearColor(prev.clearColor);
      prev.clearAlpha = renderer.getClearAlpha?.() ?? 1;
    }
    renderer.setScissorTest(false);
    if (rt && typeof renderer.setViewport === 'function') {
      renderer.setViewport(0, 0, Math.max(1, rt.width), Math.max(1, rt.height));
    }
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, false);
    return prev;
  }

  _restoreWindowLightDrawState(renderer, prev) {
    if (prev?.viewport && typeof renderer.setViewport === 'function') {
      renderer.setViewport(prev.viewport.x, prev.viewport.y, prev.viewport.z, prev.viewport.w);
    }
    if (typeof renderer.setScissorTest === 'function') {
      renderer.setScissorTest(prev?.scissorTest ?? false);
    }
    if (prev?.clearColor && typeof renderer.setClearColor === 'function') {
      renderer.setClearColor(prev.clearColor, prev.clearAlpha ?? 1);
    }
    renderer.autoClear = prev?.autoClear ?? true;
  }
}
