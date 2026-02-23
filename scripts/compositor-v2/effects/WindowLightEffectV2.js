/**
 * @fileoverview V2 Window Light Effect — per-tile additive window glow overlays.
 *
 * Minimal V2 implementation:
 *   - For each tile that has a `_Windows` (or legacy `_Structural`) mask, create
 *     an additive overlay mesh in the FloorRenderBus scene.
 *   - Floor isolation is handled by FloorRenderBus.setVisibleFloors() because
 *     overlays are registered with addEffectOverlay() using the tile's floorIndex.
 *
 * This is intentionally simpler than the V1 WindowLightEffect (no extra RTs,
 * no separate light-only pass, no rain-on-glass). It establishes the V2 pattern
 * (mask-driven bus overlay) and can be extended later.
 *
 * @module compositor-v2/effects/WindowLightEffectV2
 */

import { createLogger } from '../../core/log.js';
import { probeMaskFile } from '../../assets/loader.js';
import { tileHasLevelsRange, readTileLevelsFlags } from '../../foundry/levels-scene-flags.js';

const log = createLogger('WindowLightEffectV2');

// Z offset above albedo + specular. Must remain within the 1.0-per-floor Z band.
const WINDOW_Z_OFFSET = 0.2;

export class WindowLightEffectV2 {
  /**
   * @param {import('../FloorRenderBus.js').FloorRenderBus} renderBus
   */
  constructor(renderBus) {
    /** @type {import('../FloorRenderBus.js').FloorRenderBus} */
    this._renderBus = renderBus;

    /** @type {boolean} */
    this._enabled = true;

    /** @type {boolean} */
    this._initialized = false;

    /**
     * Per-tile overlay entries.
     * @type {Map<string, {mesh: THREE.Mesh, material: THREE.ShaderMaterial, floorIndex: number}>}
     */
    this._overlays = new Map();

    /** @type {object|null} */
    this._sharedUniforms = null;

    this.params = {
      enabled: true,
      intensity: 1.5,
      falloff: 3.0,
      color: { r: 1.0, g: 0.96, b: 0.85 },
      flickerEnabled: false,
      flickerSpeed: 0.35,
      flickerAmount: 0.15,
    };

    log.debug('WindowLightEffectV2 created');
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    this.params.enabled = this._enabled;
    if (this._sharedUniforms?.uEffectEnabled) this._sharedUniforms.uEffectEnabled.value = this._enabled;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  initialize() {
    if (this._initialized) return;
    const THREE = window.THREE;
    if (!THREE) { log.warn('initialize: THREE not available'); return; }

    this._buildSharedUniforms();

    this._initialized = true;
    log.info('WindowLightEffectV2 initialized');
  }

  clear() {
    for (const [tileId, entry] of this._overlays) {
      try { this._renderBus.removeEffectOverlay(`${tileId}_windows`); } catch (_) {}
      try { entry.material?.dispose(); } catch (_) {}
      try { entry.mesh?.geometry?.dispose(); } catch (_) {}
    }
    this._overlays.clear();
  }

  dispose() {
    this.clear();
    this._initialized = false;
    this._sharedUniforms = null;
  }

  /**
   * Populate window overlays for all tiles in the scene.
   *
   * @param {object} foundrySceneData
   */
  async populate(foundrySceneData) {
    if (!this._initialized) { log.warn('populate: not initialized'); return; }
    this.clear();

    // Use canvas.scene.tiles directly — same source as SpecularEffectV2.
    // foundrySceneData.tileDocs may be structured differently or empty.
    const tileDocs = canvas?.scene?.tiles?.contents ?? [];
    if (tileDocs.length === 0) { log.info('populate: no tiles'); return; }

    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    // worldH must match FloorRenderBus and SpecularEffectV2: use foundrySceneData.height
    // (full canvas height including padding), NOT canvas.scene.height (scene rect only).
    const worldH = foundrySceneData?.height ?? canvas?.scene?.height ?? 0;

    for (const tileDoc of tileDocs) {
      const tileId = tileDoc.id ?? tileDoc._id;
      if (!tileId) continue;
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;

      const dotIdx = src.lastIndexOf('.');
      const basePath = dotIdx > 0 ? src.substring(0, dotIdx) : src;

      // _Windows is preferred; _Structural is a legacy equivalent — both are
      // colour luminance masks with alpha defining where light hits the floor.
      const winResult = await probeMaskFile(basePath, '_Windows');
      const structResult = winResult?.path ? null : await probeMaskFile(basePath, '_Structural');
      const maskPath = winResult?.path ?? structResult?.path;
      if (!maskPath) continue;

      const floorIndex = this._resolveFloorIndex(tileDoc, floors);

      const tileW = tileDoc.width ?? 0;
      const tileH = tileDoc.height ?? 0;
      // World-space center: same Y-flip as SpecularEffectV2 and FloorRenderBus.
      const centerX = (tileDoc.x ?? 0) + tileW / 2;
      const centerY = worldH - ((tileDoc.y ?? 0) + tileH / 2);
      const rotation = typeof tileDoc.rotation === 'number'
        ? (tileDoc.rotation * Math.PI) / 180 : 0;

      // Z in bus coordinates.
      const GROUND_Z = 1000;
      const z = GROUND_Z + floorIndex + WINDOW_Z_OFFSET;

      this._createOverlay(tileId, floorIndex, {
        maskUrl: maskPath,
        centerX, centerY,
        w: tileW,
        h: tileH,
        z,
        rotation,
      });
    }

    log.info(`WindowLightEffectV2 populated: ${this._overlays.size} overlay(s)`);
  }

  /**
   * Update per-frame uniforms.
   * @param {{ elapsed: number, delta: number }} timeInfo
   */
  update(timeInfo) {
    if (!this._initialized || !this._enabled) return;

    if (this._sharedUniforms?.uTime) {
      this._sharedUniforms.uTime.value = typeof timeInfo?.elapsed === 'number' ? timeInfo.elapsed : 0;
    }

    // Sync params → uniforms (cheap; shared uniforms update all overlays).
    const u = this._sharedUniforms;
    if (!u) return;

    u.uEffectEnabled.value = !!this._enabled;
    u.uIntensity.value = Math.max(0.0, Number(this.params.intensity) || 0);
    u.uFalloff.value = Math.max(0.01, Number(this.params.falloff) || 1);

    const c = this.params.color;
    if (c && typeof c === 'object') {
      u.uColor.value.set(
        Number(c.r) || 0,
        Number(c.g) || 0,
        Number(c.b) || 0
      );
    }

    u.uFlickerEnabled.value = this.params.flickerEnabled ? 1.0 : 0.0;
    u.uFlickerSpeed.value = Math.max(0.0, Number(this.params.flickerSpeed) || 0);
    u.uFlickerAmount.value = Math.max(0.0, Number(this.params.flickerAmount) || 0);
  }

  /**
   * API parity with other V2 effects.
   * Window light is rendered via bus overlay meshes, so no explicit render pass
   * is required here.
   *
   * @param {THREE.WebGLRenderer} _renderer
   * @param {THREE.Camera} _camera
   */
  render(_renderer, _camera) {
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  _buildSharedUniforms() {
    const THREE = window.THREE;
    if (!THREE) return;

    this._sharedUniforms = {
      uEffectEnabled: { value: this._enabled ? 1.0 : 0.0 },
      uTime: { value: 0.0 },
      uIntensity: { value: Math.max(0.0, Number(this.params.intensity) || 0) },
      uFalloff: { value: Math.max(0.01, Number(this.params.falloff) || 1) },
      uColor: { value: new THREE.Color(1.0, 0.96, 0.85) },
      uFlickerEnabled: { value: 0.0 },
      uFlickerSpeed: { value: 0.35 },
      uFlickerAmount: { value: 0.15 },
      // uMask is intentionally NOT here — it is per-overlay only.
    };

    // Apply default color.
    const c = this.params.color;
    if (c && typeof c === 'object') {
      this._sharedUniforms.uColor.value.set(
        Number(c.r) || 0,
        Number(c.g) || 0,
        Number(c.b) || 0
      );
    }
  }

  _createOverlay(tileId, floorIndex, { maskUrl, centerX, centerY, w, h, z, rotation }) {
    const THREE = window.THREE;
    if (!THREE || !this._sharedUniforms) return;

    const geo = new THREE.PlaneGeometry(w, h);

    const uniforms = {
      ...this._sharedUniforms,
      // Per-overlay uniforms — not shared.
      uMask: { value: null },
      uMaskReady: { value: 0.0 },
    };

    const material = new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform float uEffectEnabled;
        uniform float uTime;
        uniform float uIntensity;
        uniform float uFalloff;
        uniform vec3  uColor;
        uniform float uFlickerEnabled;
        uniform float uFlickerSpeed;
        uniform float uFlickerAmount;
        uniform sampler2D uMask;
        uniform float uMaskReady;
        varying vec2 vUv;

        void main() {
          // Discard until the mask texture has finished loading to avoid
          // white-tile flash caused by sampling a null/uninitialized sampler.
          if (uEffectEnabled < 0.5 || uMaskReady < 0.5) discard;

          vec4 m = texture2D(uMask, vUv);
          // _Windows/_Structural mask: RGB luminance = light pool shape/colour,
          // alpha = boundary cutout (prevents light leaking outside the map).
          float maskScalar = dot(m.rgb, vec3(0.2126, 0.7152, 0.0722)) * m.a;
          if (maskScalar <= 0.001) discard;

          // Shape with gamma-like falloff — matches V1 uFalloff usage.
          float shaped = pow(clamp(maskScalar, 0.0, 1.0), uFalloff);

          // Optional subtle flicker.
          float flicker = 1.0;
          if (uFlickerEnabled > 0.5) {
            float s = sin(uTime * 6.28318 * uFlickerSpeed);
            flicker = 1.0 + (s * 0.5 + 0.5) * uFlickerAmount;
          }

          // Tint with the mask's own RGB colour, modulated by the configured colour.
          vec3 tintedColor = m.rgb * uColor;

          float lum = uIntensity * shaped * flicker;
          gl_FragColor = vec4(tintedColor * lum, shaped);
        }
      `,
    });

    // Prevent tone mapping from dimming additive glow.
    material.toneMapped = false;

    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(centerX, centerY, z);
    mesh.rotation.z = rotation;
    mesh.renderOrder = 40;

    // Register with the bus so floor visibility is handled automatically.
    this._renderBus.addEffectOverlay(`${tileId}_windows`, mesh, floorIndex);
    this._overlays.set(tileId, { mesh, material, floorIndex });

    // Load texture asynchronously.
    const loader = new THREE.TextureLoader();
    loader.load(maskUrl, (tex) => {
      // Window masks are data-ish; keep linear.
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      material.uniforms.uMask.value = tex;
      material.uniforms.uMaskReady.value = 1.0;
      material.needsUpdate = true;
    }, undefined, () => {
      log.warn(`Failed to load window mask for tile ${tileId}: ${maskUrl}`);
    });
  }

  // Exact copy of SpecularEffectV2._resolveFloorIndex — must stay in sync.
  _resolveFloorIndex(tileDoc, floors) {
    if (!floors || floors.length <= 1) return 0;

    if (tileHasLevelsRange(tileDoc)) {
      const flags = readTileLevelsFlags(tileDoc);
      const tileBottom = Number(flags.rangeBottom);
      const tileTop = Number(flags.rangeTop);
      const tileMid = (tileBottom + tileTop) / 2;

      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileMid >= f.elevationMin && tileMid <= f.elevationMax) return i;
      }
      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileBottom <= f.elevationMax && f.elevationMin <= tileTop) return i;
      }
    }

    const elev = Number.isFinite(Number(tileDoc?.elevation)) ? Number(tileDoc.elevation) : 0;
    for (let i = 0; i < floors.length; i++) {
      const f = floors[i];
      if (elev >= f.elevationMin && elev <= f.elevationMax) return i;
    }
    return 0;
  }
}
