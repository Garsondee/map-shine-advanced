/**
 * @fileoverview V2 Iridescence Effect — per-tile holographic overlays.
 *
 * Architecture mirrors other V2 surface overlays:
 * - Discover _Iridescence masks on background + tiles.
 * - Create one overlay mesh per source and register in FloorRenderBus.
 * - Keep dynamic params/lights in shared uniforms for all overlays.
 */

import { createLogger } from '../../core/log.js';
import { probeMaskFile } from '../../assets/loader.js';
import Coordinates from '../../utils/coordinates.js';
import { tileHasLevelsRange, readTileLevelsFlags } from '../../foundry/levels-scene-flags.js';

const log = createLogger('IridescenceEffectV2');

const GROUND_Z = 1000;
const IRIDESCENCE_Z_OFFSET = 0.2;
const MAX_LIGHTS = 64;

export class IridescenceEffectV2 {
  /** @param {import('../FloorRenderBus.js').FloorRenderBus} renderBus */
  constructor(renderBus) {
    this._renderBus = renderBus;
    this._enabled = true;
    this._initialized = false;
    /** @type {Map<string, {mesh: THREE.Mesh, material: THREE.ShaderMaterial, floorIndex: number}>} */
    this._overlays = new Map();
    /** @type {Map<string, any>} */
    this._lights = new Map();
    this._hookIds = {};
    this._sharedUniforms = null;

    this.params = {
      textureStatus: 'Searching...',
      hasIridescenceMask: true,
      intensity: 0.5,
      distortionStrength: 0.92,
      noiseScale: 0.68,
      noiseType: 0,
      flowSpeed: 1.5,
      phaseMult: 4.0,
      angle: 0.0,
      parallaxStrength: 3.0,
      maskThreshold: 0.34,
      colorCycleSpeed: 0.1,
      ignoreDarkness: 0.5,
      alpha: 0.5,
    };
  }

  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    if (this._sharedUniforms?.uEffectEnabled) this._sharedUniforms.uEffectEnabled.value = this._enabled;
    for (const entry of this._overlays.values()) entry.mesh.visible = this._enabled;
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        { name: 'status', label: 'Effect Status', type: 'inline', parameters: ['textureStatus'] },
        { name: 'main', label: 'Effect Properties', type: 'inline', parameters: ['intensity', 'alpha', 'flowSpeed', 'parallaxStrength', 'angle', 'maskThreshold'] },
        { name: 'style', label: 'Style & Magic', type: 'inline', parameters: ['noiseType', 'ignoreDarkness', 'colorCycleSpeed'] },
        { name: 'distortion', label: 'Distortion & Noise', type: 'folder', expanded: false, parameters: ['distortionStrength', 'noiseScale', 'phaseMult'] },
      ],
      parameters: {
        hasIridescenceMask: { type: 'boolean', default: true, hidden: true },
        textureStatus: { type: 'string', label: 'Mask Status', default: 'Checking...', readonly: true },
        intensity: { type: 'slider', label: 'Intensity', min: 0, max: 2, step: 0.01, default: 0.5 },
        alpha: { type: 'slider', label: 'Opacity', min: 0, max: 1, step: 0.01, default: 0.9 },
        noiseType: { type: 'list', label: 'Noise Type', options: { 'Liquid (Smooth)': 0, 'Glitter (Sand)': 1 }, default: 0 },
        ignoreDarkness: { type: 'slider', label: 'Ignore Darkness', min: 0, max: 1, step: 0.01, default: 0.6 },
        colorCycleSpeed: { type: 'slider', label: 'Color Cycle Speed', min: 0, max: 2, step: 0.01, default: 0.25 },
        flowSpeed: { type: 'slider', label: 'Flow Speed', min: 0, max: 5, step: 0.01, default: 0.15 },
        angle: { type: 'slider', label: 'Angle', min: 0, max: 360, step: 1, default: 0.0 },
        distortionStrength: { type: 'slider', label: 'Distortion Strength', min: 0, max: 2, step: 0.01, default: 0.13 },
        noiseScale: { type: 'slider', label: 'Noise Scale', min: 0.1, max: 4, step: 0.01, default: 0.44 },
        phaseMult: { type: 'slider', label: 'Phase Multiplier', min: 0.5, max: 6, step: 0.1, default: 6.0 },
        parallaxStrength: { type: 'slider', label: 'Parallax Strength', min: 0, max: 5, step: 0.01, default: 4.31 },
        maskThreshold: { type: 'slider', label: 'Mask Threshold', min: 0, max: 1, step: 0.01, default: 0.4 },
      }
    };
  }

  initialize() {
    if (this._initialized) return;
    const THREE = window.THREE;
    if (!THREE) return;
    this._buildSharedUniforms();
    this._registerLightHooks();
    this._syncAllLights();
    this._initialized = true;
    log.info('IridescenceEffectV2 initialized');
  }

  clear() {
    for (const [id, entry] of this._overlays) {
      this._renderBus.removeEffectOverlay(`${id}_iridescence`);
      try { entry.material.dispose(); } catch (_) {}
      try { entry.mesh.geometry?.dispose?.(); } catch (_) {}
      for (const key of ['uIridescenceMask']) {
        const tex = entry.material?.uniforms?.[key]?.value;
        try { tex?.dispose?.(); } catch (_) {}
      }
    }
    this._overlays.clear();
  }

  dispose() {
    this.clear();
    this._unregisterLightHooks();
    this._sharedUniforms = null;
    this._initialized = false;
    log.info('IridescenceEffectV2 disposed');
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
      const bgResult = await probeMaskFile(bgBasePath, '_Iridescence');
      if (bgResult?.path) {
        const sceneW = foundrySceneData?.sceneWidth ?? foundrySceneData?.width ?? 0;
        const sceneH = foundrySceneData?.sceneHeight ?? foundrySceneData?.height ?? 0;
        const sceneX = foundrySceneData?.sceneX ?? 0;
        const sceneY = foundrySceneData?.sceneY ?? 0;
        const centerX = sceneX + sceneW / 2;
        const centerY = worldH - (sceneY + sceneH / 2);
        const z = (GROUND_Z - 1) + IRIDESCENCE_Z_OFFSET;
        this._createOverlay('__bg_image__', 0, { maskUrl: bgResult.path, centerX, centerY, z, tileW: sceneW, tileH: sceneH, rotation: 0 });
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
      const result = await probeMaskFile(basePath, '_Iridescence');
      if (!result?.path) continue;

      const floorIndex = this._resolveFloorIndex(tileDoc, floors);
      const tileW = tileDoc.width ?? 0;
      const tileH = tileDoc.height ?? 0;
      const centerX = (tileDoc.x ?? 0) + tileW / 2;
      const centerY = worldH - ((tileDoc.y ?? 0) + tileH / 2);
      const rotation = typeof tileDoc.rotation === 'number' ? (tileDoc.rotation * Math.PI) / 180 : 0;
      const z = (GROUND_Z + floorIndex) + IRIDESCENCE_Z_OFFSET;

      this._createOverlay(tileId, floorIndex, { maskUrl: result.path, centerX, centerY, z, tileW, tileH, rotation });
      overlayCount++;
    }

    this.params.hasIridescenceMask = overlayCount > 0;
    this.params.textureStatus = overlayCount > 0 ? 'Ready (Texture Found)' : 'Inactive (No Texture Found)';
    log.info(`IridescenceEffectV2 populated: ${overlayCount} overlay(s)`);
  }

  update(timeInfo) {
    if (!this._initialized || !this._sharedUniforms) return;
    const u = this._sharedUniforms;

    u.uTime.value = timeInfo.elapsed;
    u.uEffectEnabled.value = this._enabled;
    u.uIntensity.value = this.params.intensity;
    u.uAlpha.value = this.params.alpha;
    u.uDistortionStrength.value = this.params.distortionStrength;
    u.uNoiseScale.value = this._mapNoiseScale(this.params.noiseScale, this.params.noiseType);
    u.uNoiseType.value = this.params.noiseType;
    u.uFlowSpeed.value = this.params.flowSpeed;
    u.uPhaseMult.value = this.params.phaseMult;
    u.uColorCycleSpeed.value = this.params.colorCycleSpeed;
    u.uAngle.value = this.params.angle * (Math.PI / 180.0);
    u.uIgnoreDarkness.value = this.params.ignoreDarkness;
    u.uParallaxStrength.value = this.params.parallaxStrength;
    u.uMaskThreshold.value = this.params.maskThreshold;

    this._updateEnvironmentUniforms();
    this._syncLightUniforms();

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

    // Screen-space token mask: suppress iridescence where token silhouettes exist.
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

  _createOverlay(tileId, floorIndex, opts) {
    const THREE = window.THREE;
    const { maskUrl, centerX, centerY, z, tileW, tileH, rotation } = opts;

    const perTileUniforms = {
      uIridescenceMask: { value: null },
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
    mesh.name = `IridescenceV2_${tileId}`;
    mesh.frustumCulled = false;
    mesh.position.set(centerX, centerY, z);
    mesh.rotation.z = rotation;

    try {
      const baseEntry = this._renderBus?._tiles?.get?.(tileId);
      const baseOrder = Number(baseEntry?.mesh?.renderOrder);
      if (Number.isFinite(baseOrder)) mesh.renderOrder = baseOrder + 5;
    } catch (_) {}

    this._renderBus.addEffectOverlay(`${tileId}_iridescence`, mesh, floorIndex);
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
      entry.material.uniforms.uIridescenceMask.value = tex;
    }, undefined, (err) => {
      log.warn(`IridescenceEffectV2: failed to load mask for ${tileId}: ${maskUrl}`, err);
    });
  }

  _buildSharedUniforms() {
    const THREE = window.THREE;
    this._sharedUniforms = {
      uEffectEnabled: { value: this._enabled },
      uRoofAlphaMap: { value: null },
      uHasRoofAlphaMap: { value: 0.0 },
      uTokenMask: { value: null },
      uHasTokenMask: { value: 0.0 },
      uTime: { value: 0.0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uIntensity: { value: this.params.intensity },
      uAlpha: { value: this.params.alpha },
      uDistortionStrength: { value: this.params.distortionStrength },
      uNoiseScale: { value: this.params.noiseScale },
      uNoiseType: { value: this.params.noiseType },
      uFlowSpeed: { value: this.params.flowSpeed },
      uPhaseMult: { value: this.params.phaseMult },
      uColorCycleSpeed: { value: this.params.colorCycleSpeed },
      uAngle: { value: this.params.angle * (Math.PI / 180.0) },
      uDarknessLevel: { value: 0.0 },
      uIgnoreDarkness: { value: this.params.ignoreDarkness },
      uParallaxStrength: { value: this.params.parallaxStrength },
      uCameraOffset: { value: new THREE.Vector2(0, 0) },
      uMaskThreshold: { value: this.params.maskThreshold },
      uAmbientDaylight: { value: new THREE.Color(1.0, 1.0, 1.0) },
      uAmbientDarkness: { value: new THREE.Color(0.14, 0.14, 0.28) },
      uAmbientBrightest: { value: new THREE.Color(1.0, 1.0, 1.0) },
      numLights: { value: 0 },
      lightPosition: { value: new Float32Array(MAX_LIGHTS * 3) },
      lightColor: { value: new Float32Array(MAX_LIGHTS * 3) },
      lightConfig: { value: new Float32Array(MAX_LIGHTS * 4) },
    };
  }

  _updateEnvironmentUniforms() {
    try {
      const scene = canvas?.scene;
      const env = canvas?.environment;
      if (scene?.environment?.darknessLevel !== undefined) {
        let darkness = scene.environment.darknessLevel;
        const le = window.MapShine?.effectComposer?._floorCompositorV2?._lightingEffect;
        if (le && typeof le.getEffectiveDarkness === 'function') darkness = le.getEffectiveDarkness();
        this._sharedUniforms.uDarknessLevel.value = darkness;
      }
      const colors = env?.colors;
      if (colors) {
        this._applyColor(colors.ambientDaylight, this._sharedUniforms.uAmbientDaylight.value);
        this._applyColor(colors.ambientDarkness, this._sharedUniforms.uAmbientDarkness.value);
        this._applyColor(colors.ambientBrightest, this._sharedUniforms.uAmbientBrightest.value);
      }
    } catch (_) {}
  }

  _applyColor(src, targetColor) {
    if (!src || !targetColor) return;
    let r = 1;
    let g = 1;
    let b = 1;
    try {
      if (Array.isArray(src)) {
        r = src[0] ?? 1; g = src[1] ?? 1; b = src[2] ?? 1;
      } else if (typeof src.r === 'number' && typeof src.g === 'number' && typeof src.b === 'number') {
        r = src.r; g = src.g; b = src.b;
      } else if (typeof src.toArray === 'function') {
        const arr = src.toArray();
        r = arr[0] ?? 1; g = arr[1] ?? 1; b = arr[2] ?? 1;
      }
    } catch (_) {}
    targetColor.setRGB(r, g, b);
  }

  _registerLightHooks() {
    if (typeof Hooks === 'undefined') return;
    this._hookIds.createAmbientLight = Hooks.on('createAmbientLight', (doc) => this._onLightCreated(doc));
    this._hookIds.updateAmbientLight = Hooks.on('updateAmbientLight', (doc, changes) => this._onLightUpdated(doc, changes));
    this._hookIds.deleteAmbientLight = Hooks.on('deleteAmbientLight', (doc) => this._onLightDeleted(doc));
  }

  _unregisterLightHooks() {
    if (typeof Hooks === 'undefined') return;
    for (const [hookName, id] of Object.entries(this._hookIds)) {
      if (id == null) continue;
      try { Hooks.off(hookName, id); } catch (_) {}
    }
    this._hookIds = {};
  }

  _syncAllLights() {
    this._lights.clear();
    const lights = canvas?.lighting?.placeables ?? [];
    for (const light of lights) this._addLight(light?.document);
    this._syncLightUniforms();
  }

  _onLightCreated(doc) { this._addLight(doc); this._syncLightUniforms(); }
  _onLightUpdated(doc, changes) {
    const merged = this._mergeLightDocChanges(doc, changes);
    this._lights.delete(merged?.id);
    this._addLight(merged);
    this._syncLightUniforms();
  }
  _onLightDeleted(doc) { if (doc?.id) this._lights.delete(doc.id); this._syncLightUniforms(); }

  _addLight(doc) {
    if (!doc?.id || this._lights.size >= MAX_LIGHTS || this._lights.has(doc.id)) return;
    const config = doc.config;
    if (!config) return;

    const radius = Math.max(config.dim || 0, config.bright || 0);
    if (radius <= 0) return;

    let r = 1;
    let g = 1;
    let b = 1;
    const colorInput = config.color;
    if (colorInput) {
      try {
        if (typeof colorInput === 'object' && colorInput.rgb) {
          r = colorInput.rgb[0]; g = colorInput.rgb[1]; b = colorInput.rgb[2];
        } else {
          const c = (typeof foundry !== 'undefined' && foundry.utils?.Color)
            ? foundry.utils.Color.from(colorInput)
            : new window.THREE.Color(colorInput);
          r = c.r; g = c.g; b = c.b;
        }
      } catch (_) {}
    }

    const worldPos = Coordinates.toWorld(doc.x, doc.y);
    const luminosity = config.luminosity ?? 0.5;
    const intensity = luminosity * 2.0;

    this._lights.set(doc.id, {
      position: worldPos,
      color: { r: r * intensity, g: g * intensity, b: b * intensity },
      radius,
      dim: config.dim || 0,
      attenuation: config.attenuation ?? 0.5,
    });
  }

  _mergeLightDocChanges(doc, changes) {
    if (!doc || !changes || typeof changes !== 'object') return doc;
    let base;
    try { base = (typeof doc.toObject === 'function') ? doc.toObject() : doc; } catch (_) { base = doc; }
    let expandedChanges = changes;
    try {
      const hasDotKeys = Object.keys(changes).some((k) => k.includes('.'));
      if (hasDotKeys && foundry?.utils?.expandObject) expandedChanges = foundry.utils.expandObject(changes);
    } catch (_) {}
    try {
      if (foundry?.utils?.mergeObject) {
        return foundry.utils.mergeObject(base, expandedChanges, {
          inplace: false, overwrite: true, recursive: true, insertKeys: true, insertValues: true,
        });
      }
    } catch (_) {}
    const merged = { ...base, ...expandedChanges };
    if (base?.config || expandedChanges?.config) merged.config = { ...(base?.config ?? {}), ...(expandedChanges?.config ?? {}) };
    return merged;
  }

  _syncLightUniforms() {
    if (!this._sharedUniforms) return;
    const lightsArray = Array.from(this._lights.values());
    const num = Math.min(lightsArray.length, MAX_LIGHTS);
    this._sharedUniforms.numLights.value = num;

    const lightPos = this._sharedUniforms.lightPosition.value;
    const lightCol = this._sharedUniforms.lightColor.value;
    const lightCfg = this._sharedUniforms.lightConfig.value;

    const d = canvas?.dimensions;
    const grid = canvas?.grid;
    const gridSizeX = (grid && typeof grid.sizeX === 'number' && grid.sizeX > 0) ? grid.sizeX : null;
    const gridSizeY = (grid && typeof grid.sizeY === 'number' && grid.sizeY > 0) ? grid.sizeY : null;
    const pxPerGrid = (gridSizeX && gridSizeY) ? (0.5 * (gridSizeX + gridSizeY)) : (d?.size ?? 100);
    const distPerGrid = (d && typeof d.distance === 'number' && d.distance > 0) ? d.distance : 1;
    const pixelsPerUnit = pxPerGrid / distPerGrid;

    for (let i = 0; i < num; i++) {
      const l = lightsArray[i];
      const i3 = i * 3;
      const i4 = i * 4;
      lightPos[i3] = l.position.x;
      lightPos[i3 + 1] = l.position.y;
      lightPos[i3 + 2] = 0;
      lightCol[i3] = l.color.r;
      lightCol[i3 + 1] = l.color.g;
      lightCol[i3 + 2] = l.color.b;
      const radiusPx = l.radius * pixelsPerUnit;
      const brightPx = l.dim * pixelsPerUnit;
      lightCfg[i4] = radiusPx;
      lightCfg[i4 + 1] = brightPx;
      lightCfg[i4 + 2] = l.attenuation;
      lightCfg[i4 + 3] = 0;
    }
  }

  _mapNoiseScale(uiNoise, noiseType) {
    const t = Math.min(Math.max(Number(uiNoise) || 0, 0), 1);
    if (Number(noiseType) === 0) {
      const minScale = 0.002;
      const maxScale = 0.05;
      return minScale * Math.pow(maxScale / minScale, t);
    }
    const minScale = 0.5;
    const maxScale = 5.0;
    return minScale * Math.pow(maxScale / minScale, t);
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
      varying vec3 vWorldPosition;
      void main() {
        vUv = uv;
        vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;
  }

  _getFragmentShader() {
    return /* glsl */`
      uniform bool uEffectEnabled;
      uniform sampler2D uIridescenceMask;
      uniform sampler2D uRoofAlphaMap;
      uniform float uHasRoofAlphaMap;
      uniform sampler2D uTokenMask;
      uniform float uHasTokenMask;
      uniform float uTime;
      uniform vec2 uResolution;
      uniform float uIntensity;
      uniform float uAlpha;
      uniform float uDistortionStrength;
      uniform float uNoiseScale;
      uniform float uNoiseType;
      uniform float uFlowSpeed;
      uniform float uPhaseMult;
      uniform float uColorCycleSpeed;
      uniform float uAngle;
      uniform float uDarknessLevel;
      uniform float uIgnoreDarkness;
      uniform float uParallaxStrength;
      uniform vec2 uCameraOffset;
      uniform float uMaskThreshold;
      uniform vec3 uAmbientDaylight;
      uniform vec3 uAmbientDarkness;
      uniform vec3 uAmbientBrightest;
      uniform int numLights;
      uniform vec3 lightPosition[${MAX_LIGHTS}];
      uniform vec3 lightColor[${MAX_LIGHTS}];
      uniform vec4 lightConfig[${MAX_LIGHTS}];

      varying vec2 vUv;
      varying vec3 vWorldPosition;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
      }

      void main() {
        if (!uEffectEnabled) discard;

        if (uHasRoofAlphaMap > 0.5) {
          vec2 roofUV = gl_FragCoord.xy / max(uResolution.xy, vec2(1.0));
          float roofA = texture2D(uRoofAlphaMap, roofUV).a;
          if (roofA > 0.05) discard;
        }

        float rawMask = texture2D(uIridescenceMask, vUv).r;
        float maskVal = smoothstep(uMaskThreshold, 1.0, rawMask);
        if (maskVal < 0.01) discard;

        vec2 screenUV = gl_FragCoord.xy / max(uResolution.xy, vec2(1.0));
        float cosA = cos(uAngle);
        float sinA = sin(uAngle);
        float diagonalSweep = screenUV.x * cosA + screenUV.y * sinA;

        float randomOffset = 0.0;
        if (uNoiseType > 0.5) {
          vec2 gridPos = floor(vWorldPosition.xy * uNoiseScale);
          vec2 jitter = vec2(hash(gridPos + 13.1), hash(gridPos + 91.7));
          randomOffset = hash(gridPos + jitter);
        } else {
          vec2 worldNoise = vWorldPosition.xy * uNoiseScale;
          const float PHI = 1.61803398875;
          mat2 rot = mat2(cos(PHI), -sin(PHI), sin(PHI), cos(PHI));
          vec2 w = rot * worldNoise;
          float n1 = sin(w.x) * cos(w.y);
          float n2 = sin(2.7 * w.x + 1.3) * cos(2.7 * w.y - 0.7);
          randomOffset = (n1 + 0.5 * n2) * 1.5;
        }

        float parallaxTerm = (uCameraOffset.x + uCameraOffset.y) * 0.001 * uParallaxStrength;
        float phase = diagonalSweep + randomOffset + (maskVal * uDistortionStrength) + (uTime * uFlowSpeed) + parallaxTerm;

        float colorPhase = phase * uColorCycleSpeed;
        vec3 rainbowColor = 0.5 + 0.5 * cos(vec3(0.0, 2.0, 4.0) + colorPhase * 6.28 * uPhaseMult);

        vec3 ambientTint = mix(uAmbientDaylight, uAmbientDarkness, uDarknessLevel);
        float ambientStrength = max(1.0 - uDarknessLevel, 0.25);
        vec3 ambientLight = ambientTint * ambientStrength;

        vec3 totalDynamicLight = vec3(0.0);
        for (int i = 0; i < ${MAX_LIGHTS}; i++) {
          if (i >= numLights) break;
          vec3 lPos = lightPosition[i];
          vec3 lColor = lightColor[i];
          float radius = lightConfig[i].x;
          float dim = lightConfig[i].y;
          float attenuation = lightConfig[i].z;
          float dist = distance(vWorldPosition.xy, lPos.xy);
          if (dist < radius) {
            float d = dist / max(radius, 0.0001);
            float inner = (radius > 0.0) ? clamp(dim / radius, 0.0, 0.99) : 0.0;
            float falloff = 1.0 - smoothstep(inner, 1.0, d);
            float linear = 1.0 - d;
            float squared = 1.0 - d * d;
            float lightIntensity = mix(linear, squared, attenuation) * falloff;
            totalDynamicLight += lColor * lightIntensity;
          }
        }

        vec3 totalIncidentLight = ambientLight + totalDynamicLight;
        float lightLuma = dot(totalIncidentLight, vec3(0.299, 0.587, 0.114));
        float litFactor = mix(lightLuma, 1.0, uIgnoreDarkness);

        vec3 finalRGB = rainbowColor * litFactor;
        float finalAlpha = clamp(maskVal * uAlpha * uIntensity, 0.0, 1.0);

        if (uHasTokenMask > 0.5) {
          vec2 tokenUv = gl_FragCoord.xy / max(uResolution.xy, vec2(1.0));
          float tokenMask01 = smoothstep(0.1, 0.9, texture2D(uTokenMask, tokenUv).a);
          float keep = 1.0 - tokenMask01;
          finalRGB *= keep;
          finalAlpha *= keep;
        }

        gl_FragColor = vec4(finalRGB, finalAlpha);
      }
    `;
  }
}
