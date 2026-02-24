/**
 * @fileoverview V2 Window Light Effect — per-tile additive window glow overlays.
 *
 * Architecture:
 *   - For each tile that has a `_Windows` (or legacy `_Structural`) mask, create
 *     an additive overlay mesh in an ISOLATED scene (NOT the FloorRenderBus scene).
 *   - FloorCompositor passes `_scene` directly into `LightingEffectV2.render()` as
 *     the `windowLightScene` argument. LightingEffectV2 renders it additively into
 *     `_lightRT` (the light accumulation buffer) BEFORE the compose step.
 *
 * Why this is correct:
 *   The lighting compose shader does `litColor = albedo * totalIllumination`.
 *   By contributing to `totalIllumination` (via `_lightRT`), window light naturally
 *   tints itself by the surface albedo — a red surface stays red under warm light.
 *   Pure additive post-lighting would add white light uniformly, desaturating colours.
 *
 * Floor isolation is handled by manually toggling mesh visibility in
 * onFloorChange() since the overlays are not in the bus scene.
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
  constructor() {
    /** @type {boolean} */
    this._enabled = true;

    /** @type {boolean} */
    this._initialized = false;

    /**
     * Isolated Three.js scene — overlays live here, NOT in the FloorRenderBus
     * scene, so they are rendered after the lighting pass.
     * @type {THREE.Scene|null}
     */
    this._scene = null;

    /** @type {number} Active floor index for visibility gating. */
    this._activeMaxFloor = Infinity;

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
      // RGB shift (chromatic dispersion / refraction)
      rgbShiftAmount: 1.9,  // pixels
      rgbShiftAngle: 76.0,  // degrees
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

    this._scene = new THREE.Scene();
    this._scene.name = 'WindowLightScene';

    this._buildSharedUniforms();

    this._initialized = true;
    log.info('WindowLightEffectV2 initialized');
  }

  clear() {
    for (const [, entry] of this._overlays) {
      try { this._scene?.remove(entry.mesh); } catch (_) {}
      try { entry.material?.dispose(); } catch (_) {}
      try { entry.mesh?.geometry?.dispose(); } catch (_) {}
    }
    this._overlays.clear();
  }

  dispose() {
    this.clear();
    this._scene = null;
    this._initialized = false;
    this._sharedUniforms = null;
  }

  /**
   * Update overlay visibility when the active floor changes.
   * Mirrors the FloorRenderBus.setVisibleFloors() logic.
   * @param {number} maxFloorIndex
   */
  onFloorChange(maxFloorIndex) {
    this._activeMaxFloor = maxFloorIndex;
    for (const entry of this._overlays.values()) {
      entry.mesh.visible = entry.floorIndex <= maxFloorIndex;
    }
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
      // THREE.Color.set() takes a single arg; use setRGB for component-wise assignment.
      u.uColor.value.setRGB(
        Number(c.r) || 0,
        Number(c.g) || 0,
        Number(c.b) || 0
      );
    }

    u.uFlickerEnabled.value = this.params.flickerEnabled ? 1.0 : 0.0;
    u.uFlickerSpeed.value = Math.max(0.0, Number(this.params.flickerSpeed) || 0);
    u.uFlickerAmount.value = Math.max(0.0, Number(this.params.flickerAmount) || 0);

    // RGB shift — convert angle from degrees to radians each frame so live
    // tweaks take effect without requiring a repopulate.
    u.uRgbShiftAmount.value = Math.max(0.0, Number(this.params.rgbShiftAmount) || 0);
    u.uRgbShiftAngle.value = (Number(this.params.rgbShiftAngle) || 0) * (Math.PI / 180.0);
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

    const c = this.params.color;
    const cr = (c && typeof c === 'object') ? (Number(c.r) || 0) : 1.0;
    const cg = (c && typeof c === 'object') ? (Number(c.g) || 0) : 0.96;
    const cb = (c && typeof c === 'object') ? (Number(c.b) || 0) : 0.85;

    this._sharedUniforms = {
      uEffectEnabled: { value: this._enabled ? 1.0 : 0.0 },
      uTime: { value: 0.0 },
      uIntensity: { value: Math.max(0.0, Number(this.params.intensity) || 0) },
      uFalloff: { value: Math.max(0.01, Number(this.params.falloff) || 1) },
      uColor: { value: new THREE.Color(cr, cg, cb) },
      uFlickerEnabled: { value: 0.0 },
      uFlickerSpeed: { value: 0.35 },
      uFlickerAmount: { value: 0.15 },
      // RGB shift (chromatic dispersion) — pixel offset split into R/B channels.
      uRgbShiftAmount: { value: Math.max(0.0, Number(this.params.rgbShiftAmount) || 0) },
      uRgbShiftAngle: { value: (Number(this.params.rgbShiftAngle) || 0) * (Math.PI / 180.0) },
      // uWindowTexelSize and uMask are per-overlay only (set in _createOverlay).
    };
  }

  _createOverlay(tileId, floorIndex, { maskUrl, centerX, centerY, w, h, z, rotation }) {
    const THREE = window.THREE;
    if (!THREE || !this._sharedUniforms) return;

    const geo = new THREE.PlaneGeometry(w, h);

    // uWindowTexelSize is per-overlay because each tile has its own pixel dimensions.
    // It is updated once the texture loads (actual texel size from tex.image).
    // uMask and uMaskReady are also per-overlay.
    // All other uniforms reference the shared objects so param changes propagate
    // to every overlay without iterating them.
    const uniforms = {
      ...this._sharedUniforms,
      uMask: { value: null },
      uMaskReady: { value: 0.0 },
      // 1/texWidth, 1/texHeight — set once texture loads.
      uWindowTexelSize: { value: new THREE.Vector2(1.0 / w, 1.0 / h) },
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
        uniform float uRgbShiftAmount;
        uniform float uRgbShiftAngle;
        uniform vec2  uWindowTexelSize;
        uniform sampler2D uMask;
        uniform float uMaskReady;
        varying vec2 vUv;

        float msLuminance(vec3 c) {
          return dot(c, vec3(0.2126, 0.7152, 0.0722));
        }

        void main() {
          // Discard until the mask texture has finished loading to avoid
          // white-tile flash caused by sampling a null/uninitialized sampler.
          if (uEffectEnabled < 0.5 || uMaskReady < 0.5) discard;

          // Boundary alpha check at the unshifted UV — cuts out areas outside
          // the map tile footprint.
          vec4 mCenter = texture2D(uMask, vUv);
          if (mCenter.a < 0.01) discard;

          // RGB Shift (chromatic dispersion / refraction):
          // Sample the mask three times — R channel offset forward along the
          // shift direction, G channel unshifted, B channel offset backward.
          // This replicates the V1 WindowLightEffect refraction behaviour.
          vec2 shiftDir = vec2(cos(uRgbShiftAngle), sin(uRgbShiftAngle));
          vec2 rOffset  = shiftDir * uRgbShiftAmount * uWindowTexelSize;
          vec2 bOffset  = -rOffset;

          float maskR = msLuminance(texture2D(uMask, clamp(vUv + rOffset, 0.001, 0.999)).rgb);
          float maskG = msLuminance(mCenter.rgb);
          float maskB = msLuminance(texture2D(uMask, clamp(vUv + bOffset, 0.001, 0.999)).rgb);

          // Average luminance drives the overall shape/falloff.
          float maskScalar = (maskR + maskG + maskB) / 3.0;
          if (maskScalar <= 0.001) discard;

          // Shape with gamma-like falloff — matches V1 uFalloff usage.
          // Apply falloff per-channel so the RGB split is visible in the shaped output.
          vec3 shaped = pow(clamp(vec3(maskR, maskG, maskB), 0.0, 1.0), vec3(uFalloff));

          // Optional subtle flicker.
          float flicker = 1.0;
          if (uFlickerEnabled > 0.5) {
            // Use two sine frequencies for a less mechanical flicker.
            float s = sin(uTime * 6.28318 * uFlickerSpeed)
                    * 0.7 + sin(uTime * 6.28318 * uFlickerSpeed * 2.73) * 0.3;
            flicker = 1.0 + s * uFlickerAmount;
          }

          // The _Windows mask is a greyscale luminance/shape map — its RGB
          // channels are all equal and carry no color information. Use the
          // per-channel shaped luminance directly and tint with uColor only.
          // This matches V1 behaviour: mask drives shape, uColor drives tint.
          vec3 lightOut = shaped * uColor * uIntensity * flicker;

          // Output raw linear light — no tone mapping on additive overlays.
          // AdditiveBlending: dst += src.rgb * src.a. Alpha=1 so the full
          // light value is added; intensity is baked into RGB.
          gl_FragColor = vec4(lightOut, 1.0);
        }
      `,
    });

    // Prevent tone mapping from dimming additive glow.
    material.toneMapped = false;

    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(centerX, centerY, z);
    mesh.rotation.z = rotation;
    mesh.renderOrder = 40;

    // Add to the isolated window light scene (not the bus scene).
    // Floor visibility is managed by onFloorChange() instead of the bus.
    this._scene.add(mesh);
    this._overlays.set(tileId, { mesh, material, floorIndex });

    // Load texture asynchronously.
    const loader = new THREE.TextureLoader();
    loader.load(maskUrl, (tex) => {
      // Window masks are greyscale luminance/shape data — treat as linear.
      // Setting SRGBColorSpace would gamma-decode the mask values, making the
      // shape brighter than intended and breaking the luminance-driven falloff.
      tex.colorSpace = THREE.NoColorSpace;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;

      // Update texel size from actual image dimensions so the RGB shift is
      // expressed in true pixels regardless of tile display size.
      const imgW = tex.image?.width ?? w;
      const imgH = tex.image?.height ?? h;
      material.uniforms.uWindowTexelSize.value.set(1.0 / imgW, 1.0 / imgH);

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
