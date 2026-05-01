/**
 * @fileoverview V2 Prism Effect — per-tile crystal/glass refraction overlays.
 *
 * Architecture mirrors other V2 surface overlays:
 * - Discover _Prism masks on background + tiles.
 * - Create one overlay mesh per source and register in FloorRenderBus.
 * - Keep dynamic params in shared uniforms for all overlays.
 */

import { createLogger } from '../../core/log.js';
import { probeMaskFile } from '../../assets/loader.js';
import { tileHasLevelsRange, readTileLevelsFlags } from '../../foundry/levels-scene-flags.js';
import { tileRelativeEffectOrder } from '../LayerOrderPolicy.js';

const log = createLogger('PrismEffectV2');

const GROUND_Z = 1000;
const PRISM_Z_OFFSET = 0.3;

export class PrismEffectV2 {
  /** @param {import('../FloorRenderBus.js').FloorRenderBus} renderBus */
  constructor(renderBus) {
    this._renderBus = renderBus;
    this._enabled = true;
    this._initialized = false;

    /** @type {Map<string, {mesh: THREE.Mesh, material: THREE.ShaderMaterial, floorIndex: number}>} */
    this._overlays = new Map();
    this._sharedUniforms = null;

    this.params = {
      textureStatus: 'Searching...',
      hasPrismMask: false,

      intensity: 0.3,
      spread: 0.5,
      facetScale: 254.0,
      facetAnimate: true,
      facetSpeed: 1.01,
      facetSoftness: 0.85,
      brightness: 0.8,
      opacity: 0.5,
      maskThreshold: 0.9,
      parallaxStrength: 2.4,
      glintStrength: 0.45,
      glintThreshold: 0.13,
    };
  }

  get enabled() {
    return this._enabled;
  }

  set enabled(value) {
    this._enabled = !!value;
    if (this._sharedUniforms?.uEffectEnabled) this._sharedUniforms.uEffectEnabled.value = this._enabled;
    for (const entry of this._overlays.values()) entry.mesh.visible = this._enabled;
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        { name: 'status', label: 'Effect Status', type: 'inline', parameters: ['textureStatus'] },
        { name: 'refraction', label: 'Refraction', type: 'folder', parameters: ['intensity', 'spread', 'brightness', 'opacity', 'maskThreshold'] },
        { name: 'facets', label: 'Crystal Facets', type: 'folder', parameters: ['facetScale', 'facetAnimate', 'facetSpeed', 'facetSoftness'] },
        { name: 'parallax', label: 'Camera Parallax', type: 'inline', parameters: ['parallaxStrength'] },
        { name: 'glint', label: 'Surface Glint', type: 'folder', parameters: ['glintStrength', 'glintThreshold'] },
      ],
      parameters: {
        textureStatus: { type: 'string', label: 'Mask Status', default: 'Checking...', readonly: true },
        intensity: { type: 'slider', label: 'Distortion', min: 0, max: 5.0, step: 0.1, default: 0.3 },
        spread: { type: 'slider', label: 'Spectral Spread', min: 0.0, max: 1.0, step: 0.1, default: 0.6 },
        brightness: { type: 'slider', label: 'Brightness Boost', min: 0.5, max: 3.0, step: 0.1, default: 1.5 },
        opacity: { type: 'slider', label: 'Opacity', min: 0.0, max: 1.0, step: 0.05, default: 0.25 },
        maskThreshold: { type: 'slider', label: 'Mask Brightness Cutoff', min: 0.0, max: 1.0, step: 0.01, default: 0.9 },
        facetScale: { type: 'slider', label: 'Facet Scale', min: 1.0, max: 1000.0, step: 1.0, default: 254.0 },
        facetAnimate: { type: 'boolean', label: 'Animate Facets', default: true },
        facetSpeed: { type: 'slider', label: 'Animation Speed', min: 0.0, max: 2.0, step: 0.01, default: 1.01 },
        facetSoftness: { type: 'slider', label: 'Facet Softness', min: 0.0, max: 1.0, step: 0.01, default: 0.85 },
        parallaxStrength: { type: 'slider', label: 'Parallax Strength', min: 0.0, max: 5.0, step: 0.05, default: 2.4 },
        glintStrength: { type: 'slider', label: 'Glint Strength', min: 0.0, max: 2.0, step: 0.05, default: 0.4 },
        glintThreshold: { type: 'slider', label: 'Glint Sharpness', min: 0.0, max: 0.99, step: 0.01, default: 0.13 },
      },
    };
  }

  initialize() {
    if (this._initialized) return;
    const THREE = window.THREE;
    if (!THREE) return;

    this._buildSharedUniforms();
    this._initialized = true;
    log.info('PrismEffectV2 initialized');
  }

  clear() {
    for (const [id, entry] of this._overlays) {
      this._renderBus.removeEffectOverlay(`${id}_prism`);
      try { entry.material.dispose(); } catch (_) {}
      try { entry.mesh.geometry?.dispose?.(); } catch (_) {}
      for (const key of ['uPrismMask', 'uBaseMap']) {
        const tex = entry.material?.uniforms?.[key]?.value;
        try { tex?.dispose?.(); } catch (_) {}
      }
    }
    this._overlays.clear();
  }

  /**
   * @param {string} tileId
   * @private
   */
  _disposeOverlayEntry(tileId) {
    if (!tileId || tileId === '__bg_image__') return;
    const entry = this._overlays.get(tileId);
    if (!entry) return;
    this._renderBus.removeEffectOverlay(`${tileId}_prism`);
    try { entry.material.dispose(); } catch (_) {}
    try { entry.mesh.geometry?.dispose?.(); } catch (_) {}
    for (const key of ['uPrismMask', 'uBaseMap']) {
      const tex = entry.material?.uniforms?.[key]?.value;
      try { tex?.dispose?.(); } catch (_) {}
    }
    this._overlays.delete(tileId);
  }

  /**
   * Re-probe `_Prism` and rebuild the overlay after `texture.src` changed on a tile.
   *
   * @param {object} tileDoc
   * @param {object|null} foundrySceneData
   */
  async refreshTileAfterTextureChange(tileDoc, foundrySceneData) {
    if (!this._initialized || !tileDoc) return;
    const tileId = tileDoc.id ?? tileDoc._id;
    if (!tileId || tileId === '__bg_image__') return;

    this._disposeOverlayEntry(tileId);

    const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
    if (!src) return;

    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    const worldH = foundrySceneData?.height ?? (typeof canvas !== 'undefined' ? canvas?.dimensions?.height : 0) ?? 0;

    const basePath = this._basePathNoExt(src);
    const result = await probeMaskFile(basePath, '_Prism');
    if (!result?.path) return;

    const floorIndex = this._resolveFloorIndex(tileDoc, floors);
    const tileW = tileDoc.width ?? 0;
    const tileH = tileDoc.height ?? 0;
    const centerX = (tileDoc.x ?? 0) + tileW / 2;
    const centerY = worldH - ((tileDoc.y ?? 0) + tileH / 2);
    const rotation = typeof tileDoc.rotation === 'number' ? (tileDoc.rotation * Math.PI) / 180 : 0;
    const z = (GROUND_Z + floorIndex) + PRISM_Z_OFFSET;

    this._createOverlay(tileId, floorIndex, {
      maskUrl: result.path,
      baseUrl: src,
      centerX,
      centerY,
      z,
      tileW,
      tileH,
      rotation,
    });
  }

  dispose() {
    this.clear();
    this._sharedUniforms = null;
    this._initialized = false;
    log.info('PrismEffectV2 disposed');
  }

  async populate(foundrySceneData) {
    if (!this._initialized) return;
    this.clear();

    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    const worldH = foundrySceneData?.height ?? 0;
    let overlayCount = 0;

    const bgSrc = canvas?.scene?.background?.src ?? '';
    if (bgSrc) {
      const bgBasePath = this._basePathNoExt(bgSrc);
      const bgResult = await probeMaskFile(bgBasePath, '_Prism');
      if (bgResult?.path) {
        const sceneW = foundrySceneData?.sceneWidth ?? foundrySceneData?.width ?? 0;
        const sceneH = foundrySceneData?.sceneHeight ?? foundrySceneData?.height ?? 0;
        const sceneX = foundrySceneData?.sceneX ?? 0;
        const sceneY = foundrySceneData?.sceneY ?? 0;
        const centerX = sceneX + sceneW / 2;
        const centerY = worldH - (sceneY + sceneH / 2);
        const z = (GROUND_Z - 1) + PRISM_Z_OFFSET;
        this._createOverlay('__bg_image__', 0, {
          maskUrl: bgResult.path,
          baseUrl: bgSrc,
          centerX,
          centerY,
          z,
          tileW: sceneW,
          tileH: sceneH,
          rotation: 0,
        });
        overlayCount++;
      }
    }

    const tileDocs = canvas?.scene?.tiles?.contents ?? [];
    for (const tileDoc of tileDocs) {
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;
      const tileId = tileDoc?.id ?? tileDoc?._id;
      if (!tileId) continue;

      const basePath = this._basePathNoExt(src);
      const result = await probeMaskFile(basePath, '_Prism');
      if (!result?.path) continue;

      const floorIndex = this._resolveFloorIndex(tileDoc, floors);
      const tileW = tileDoc.width ?? 0;
      const tileH = tileDoc.height ?? 0;
      const centerX = (tileDoc.x ?? 0) + tileW / 2;
      const centerY = worldH - ((tileDoc.y ?? 0) + tileH / 2);
      const rotation = typeof tileDoc.rotation === 'number' ? (tileDoc.rotation * Math.PI) / 180 : 0;
      const z = (GROUND_Z + floorIndex) + PRISM_Z_OFFSET;

      this._createOverlay(tileId, floorIndex, {
        maskUrl: result.path,
        baseUrl: src,
        centerX,
        centerY,
        z,
        tileW,
        tileH,
        rotation,
      });
      overlayCount++;
    }

    this.params.hasPrismMask = overlayCount > 0;
    this.params.textureStatus = overlayCount > 0 ? 'Ready (Texture Found)' : 'Inactive (No Texture Found)';
    log.info(`PrismEffectV2 populated: ${overlayCount} overlay(s)`);
  }

  update(timeInfo) {
    if (!this._initialized || !this._sharedUniforms) return;
    const u = this._sharedUniforms;

    u.uTime.value = timeInfo.elapsed;
    u.uEffectEnabled.value = this._enabled;
    u.uIntensity.value = this.params.intensity;
    u.uSpread.value = this.params.spread;
    u.uBrightness.value = this.params.brightness;
    u.uOpacity.value = this.params.opacity;
    u.uFacetScale.value = this.params.facetScale;
    u.uFacetSpeed.value = this.params.facetAnimate ? this.params.facetSpeed : 0.0;
    u.uFacetSoftness.value = this.params.facetSoftness;
    u.uParallaxStrength.value = this.params.parallaxStrength;
    u.uMaskThreshold.value = this.params.maskThreshold;
    u.uGlintStrength.value = this.params.glintStrength;
    u.uGlintThreshold.value = this.params.glintThreshold;

    for (const { mesh } of this._overlays.values()) mesh.visible = this._enabled;
  }

  render(renderer, camera) {
    if (!this._initialized || !this._sharedUniforms || this._overlays.size === 0) return;
    const THREE = window.THREE;
    const u = this._sharedUniforms;

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    u.uResolution.value.set(size.x, size.y);

    let cx = 0;
    let cy = 0;
    if (camera?.isPerspectiveCamera) {
      cx = camera.position.x;
      cy = camera.position.y;
    } else if (camera?.isOrthographicCamera) {
      cx = (camera.left + camera.right) / 2;
      cy = (camera.top + camera.bottom) / 2;
    }
    u.uCameraOffset.value.set(cx, cy);

    const roofTex = window.MapShine?.effectComposer?._floorCompositorV2?._overheadShadowEffect?.roofAlphaTexture ?? null;
    u.uRoofAlphaMap.value = roofTex;
    u.uHasRoofAlphaMap.value = roofTex ? 1.0 : 0.0;

    // Screen-space token mask: suppress prism overlay where token silhouettes exist.
    try {
      const mm = window.MapShine?.maskManager;
      let tokenMaskTex = mm?.getTexture?.('tokenMask.screen') ?? null;
      if (!tokenMaskTex) {
        tokenMaskTex = window.MapShine?.lightingEffect?.tokenMaskTarget?.texture ?? null;
      }
      u.uTokenMask.value = tokenMaskTex;
      u.uHasTokenMask.value = tokenMaskTex ? 1.0 : 0.0;
    } catch (_) {
      u.uTokenMask.value = null;
      u.uHasTokenMask.value = 0.0;
    }
  }

  _buildSharedUniforms() {
    const THREE = window.THREE;
    this._sharedUniforms = {
      uEffectEnabled: { value: this._enabled },
      uPrismMask: { value: null },
      uBaseMap: { value: null },
      uRoofAlphaMap: { value: null },
      uHasRoofAlphaMap: { value: 0.0 },
      uTokenMask: { value: null },
      uHasTokenMask: { value: 0.0 },
      uTime: { value: 0.0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uIntensity: { value: this.params.intensity },
      uSpread: { value: this.params.spread },
      uBrightness: { value: this.params.brightness },
      uOpacity: { value: this.params.opacity },
      uFacetScale: { value: this.params.facetScale },
      uFacetSpeed: { value: this.params.facetSpeed },
      uFacetSoftness: { value: this.params.facetSoftness },
      uParallaxStrength: { value: this.params.parallaxStrength },
      uMaskThreshold: { value: this.params.maskThreshold },
      uGlintStrength: { value: this.params.glintStrength },
      uGlintThreshold: { value: this.params.glintThreshold },
      uCameraOffset: { value: new THREE.Vector2(0, 0) },
    };
  }

  _createOverlay(tileId, floorIndex, opts) {
    const THREE = window.THREE;
    const { maskUrl, baseUrl, centerX, centerY, z, tileW, tileH, rotation } = opts;

    const perTileUniforms = {
      uPrismMask: { value: null },
      uBaseMap: { value: null },
    };
    const uniforms = { ...this._sharedUniforms, ...perTileUniforms };

    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: this._getVertexShader(),
      fragmentShader: this._getFragmentShader(),
      side: THREE.DoubleSide,
      transparent: true,
      blending: THREE.NormalBlending,
      depthWrite: false,
      depthTest: true,
    });

    const geometry = new THREE.PlaneGeometry(tileW, tileH);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `PrismV2_${tileId}`;
    mesh.frustumCulled = false;
    mesh.position.set(centerX, centerY, z);
    mesh.rotation.z = rotation;

    try {
      const baseEntry = this._renderBus?._tiles?.get?.(tileId);
      const baseOrder = Number(baseEntry?.mesh?.renderOrder);
      const isOverhead = !!baseEntry?.root?.userData?.isOverhead;
      if (Number.isFinite(baseOrder)) {
        mesh.renderOrder = tileRelativeEffectOrder(baseOrder, floorIndex, isOverhead, 6);
      }
    } catch (_) {}

    this._renderBus.addEffectOverlay(`${tileId}_prism`, mesh, floorIndex);
    this._overlays.set(tileId, { mesh, material, floorIndex });

    const loader = new THREE.TextureLoader();
    loader.load(maskUrl, (tex) => {
      tex.flipY = true;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      const entry = this._overlays.get(tileId);
      if (!entry) {
        try { tex.dispose(); } catch (_) {}
        return;
      }
      entry.material.uniforms.uPrismMask.value = tex;
    }, undefined, (err) => {
      log.warn(`PrismEffectV2: failed to load prism mask for ${tileId}: ${maskUrl}`, err);
    });

    loader.load(baseUrl, (tex) => {
      tex.flipY = true;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      const entry = this._overlays.get(tileId);
      if (!entry) {
        try { tex.dispose(); } catch (_) {}
        return;
      }
      entry.material.uniforms.uBaseMap.value = tex;
    }, undefined, (err) => {
      log.warn(`PrismEffectV2: failed to load base texture for ${tileId}: ${baseUrl}`, err);
    });
  }

  _basePathNoExt(src) {
    const s = String(src ?? '');
    const dot = s.lastIndexOf('.');
    return dot > 0 ? s.substring(0, dot) : s;
  }

  _resolveFloorIndex(tileDoc, floors) {
    if (!floors || floors.length <= 1) return 0;
    if (tileHasLevelsRange(tileDoc)) {
      const flags = readTileLevelsFlags(tileDoc);
      const tileBottom = Number(flags.rangeBottom);
      const tileTop = Number(flags.rangeTop);
      const tileMid = (tileBottom + tileTop) / 2;
      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileMid >= f.elevationMin && tileMid < f.elevationMax) return i;
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

  _getVertexShader() {
    return /* glsl */`
      varying vec2 vUv;
      varying vec2 vWorldUv;
      varying vec3 vWorldPosition;

      void main() {
        vUv = uv;

        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;

        // Simple world UVs for consistent noise scale regardless of mesh transform.
        vWorldUv = worldPosition.xy * 0.001;

        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `;
  }

  _getFragmentShader() {
    return /* glsl */`
      uniform bool uEffectEnabled;
      uniform sampler2D uBaseMap;
      uniform sampler2D uPrismMask;
      uniform sampler2D uRoofAlphaMap;
      uniform float uHasRoofAlphaMap;
      uniform sampler2D uTokenMask;
      uniform float uHasTokenMask;
      uniform float uTime;
      uniform vec2 uResolution;

      uniform float uIntensity;
      uniform float uSpread;
      uniform float uBrightness;
      uniform float uOpacity;
      uniform float uFacetScale;
      uniform float uFacetSpeed;
      uniform float uFacetSoftness;
      uniform float uParallaxStrength;
      uniform float uMaskThreshold;
      uniform float uGlintStrength;
      uniform float uGlintThreshold;
      uniform vec2 uCameraOffset;

      varying vec2 vUv;
      varying vec2 vWorldUv;

      vec2 hash2(vec2 p) {
        return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
      }

      vec3 voronoi(in vec2 x) {
        vec2 n = floor(x);
        vec2 f = fract(x);
        vec2 m = vec2(8.0);
        vec2 center = vec2(0.0);

        for (int j = -1; j <= 1; j++)
        for (int i = -1; i <= 1; i++) {
          vec2 g = vec2(float(i), float(j));
          vec2 o = hash2(n + g);

          o = 0.5 + 0.5 * sin(uTime * uFacetSpeed + 6.2831 * o);

          vec2 r = g - f + o;
          float d = dot(r, r);
          if (d < m.x) {
            m.x = d;
            m.y = d;
            center = r;
          }
        }

        return vec3(m.x, center);
      }

      void main() {
        if (!uEffectEnabled) discard;

        if (uHasRoofAlphaMap > 0.5) {
          vec2 roofUV = gl_FragCoord.xy / max(uResolution.xy, vec2(1.0));
          float roofA = texture2D(uRoofAlphaMap, roofUV).a;
          if (roofA > 0.05) discard;
        }

        vec4 maskSample = texture2D(uPrismMask, vUv);
        float rawMask = maskSample.r;

        float mask = smoothstep(uMaskThreshold, 1.0, rawMask);
        if (mask < 0.01) discard;

        vec2 parallaxOffset = uCameraOffset * 0.0001 * uParallaxStrength;
        vec2 noiseUv = (vUv + parallaxOffset) * uFacetScale;
        vec3 v = voronoi(noiseUv);

        vec2 facetSlope = v.yz;
        vec2 glassSlope = normalize(vWorldUv * 0.5 + 0.0001);
        vec2 finalSlope = mix(facetSlope, glassSlope, clamp(uFacetSoftness, 0.0, 1.0));

        float distAmt = uIntensity * 0.01;
        vec2 offsetR = finalSlope * distAmt * (1.0 + uSpread);
        vec2 offsetG = finalSlope * distAmt;
        vec2 offsetB = finalSlope * distAmt * (1.0 - uSpread);

        float r = texture2D(uBaseMap, vUv + offsetR).r;
        float g = texture2D(uBaseMap, vUv + offsetG).g;
        float b = texture2D(uBaseMap, vUv + offsetB).b;

        vec3 refractionColor = vec3(r, g, b);
        refractionColor *= uBrightness;

        vec2 lightDir = vec2(sin(uTime * 0.5), cos(uTime * 0.3));
        float glint = dot(normalize(finalSlope), normalize(lightDir));
        glint = smoothstep(uGlintThreshold, 1.0, glint);

        refractionColor += vec3(glint * uGlintStrength);

        float finalAlpha = mask * uOpacity;
        if (uHasTokenMask > 0.5) {
          vec2 tokenUv = gl_FragCoord.xy / max(uResolution.xy, vec2(1.0));
          float tokenMask01 = smoothstep(0.1, 0.9, texture2D(uTokenMask, tokenUv).a);
          float keep = 1.0 - tokenMask01;
          refractionColor *= keep;
          finalAlpha *= keep;
        }

        gl_FragColor = vec4(refractionColor, finalAlpha);
      }
    `;
  }
}
