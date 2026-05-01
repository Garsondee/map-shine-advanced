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
import { getTileBusPlaneSizeAndMirror, getTileVisualCenterFoundryXY } from '../../scene/tile-manager.js';
import { GROUND_Z, Z_PER_FLOOR, tileRelativeEffectOrder } from '../LayerOrderPolicy.js';
import { resolveEffectEnabled } from '../../effects/resolve-effect-enabled.js';

const log = createLogger('IridescenceEffectV2');

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
    /** @type {THREE.DataTexture|null} */
    this._fallbackBlack = null;

    this.params = {
      enabled: true,
      textureStatus: 'Searching...',
      /** Set in populate(); retained for scene state / tools (not a Tweakpane control). */
      hasIridescenceMask: true,
      intensity: 0.5,
      distortionStrength: 0.92,
      noiseScale: 0.68,
      noiseType: 0,
      flowSpeed: 1.5,
      phaseMult: 4.0,
      angle: 0.0,
      parallaxStrength: 3.0,
      maskThreshold: 0.05,
      /** When true, uses (1 − luminance) × α — for masks painted dark-on-light instead of white = shine. */
      invertMask: false,
      colorCycleSpeed: 0.1,
      ignoreDarkness: 0.5,
      alpha: 0.5,
    };
  }

  get enabled() { return this._enabled; }
  set enabled(v) {
    const next = !!v;
    this._enabled = next;
    this.params.enabled = next;
    if (this._sharedUniforms?.uEffectEnabled) {
      this._sharedUniforms.uEffectEnabled.value = resolveEffectEnabled(this);
    }
    this._syncOverlayVisibility();
  }

  static getControlSchema() {
    return {
      enabled: true,
      help: {
        title: 'Iridescence (_Iridescence masks)',
        summary: [
          'Adds a **thin-film / holographic** layer on tiles (and the scene background) that ship a matching **`_Iridescence`** texture next to the art.',
          'The shader blends **screen-space flow**, **world noise**, and **mask-driven distortion** into shifting spectral color. **Foundry lights** tint the result; **ignore darkness** keeps color visible in shadow.',
          'One overlay per masked source, on the floor bus — visibility follows level/floor rules like Specular/Bush.',
          'Tile overlays are **parented to the same bus transform as the albedo tile** (like Specular V2) so mask UVs stay locked to the art.',
          '**Mask rule:** **luminance × α** — paint **light** where shimmer goes; transparent stays empty. **Invert mask** flips black↔white for inverse paint.',
          '**Noise scale** is a **0–1 UI** value mapped internally to shader frequency (higher = finer detail).',
          'Settings save with the scene (not World Based).',
        ].join('\n\n'),
        glossary: {
          'Mask status': 'Whether the scene found at least one `_Iridescence` mask after load.',
          Intensity: 'Strength of the iridescent color contribution.',
          Opacity: 'Master alpha for the additive layer (`alpha` uniform).',
          'Flow speed': 'How fast the phase field scrolls in screen UV space.',
          'Parallax strength': 'How much the view offset shifts the pattern (camera parallax).',
          'Ignore darkness': 'How much to resist Foundry darkness / night tint on the effect (0 = full scene darkening, 1 = mostly ignore).',
          'Color cycle speed': 'Rate of hue rotation over time.',
          'Noise type': 'Liquid = smoother bands; Glitter = grainier, sparklier noise.',
          'Distortion strength': 'How strongly the mask warps UVs into the noise field.',
          'Noise scale': 'UI 0–1 mapped to internal noise frequency (see summary).',
          'Phase multiplier': 'Scales interference fringe density.',
          'Mask threshold': 'Cutoff on decoded mask strength — higher keeps only stronger regions.',
          'Invert mask': 'Turn **on** to flip black↔white (shine follows **dark** pixels instead of bright).',
        },
      },
      presetApplyDefaults: true,
      groups: [
        {
          name: 'status',
          label: 'Status',
          type: 'folder',
          expanded: true,
          parameters: ['textureStatus'],
        },
        {
          name: 'look',
          label: 'Look',
          type: 'folder',
          expanded: true,
          parameters: ['intensity', 'alpha'],
        },
        {
          name: 'motion',
          label: 'Motion & parallax',
          type: 'folder',
          expanded: true,
          parameters: ['flowSpeed', 'angle', 'parallaxStrength'],
        },
        {
          name: 'spectral',
          label: 'Spectral & lighting',
          type: 'folder',
          expanded: false,
          parameters: ['noiseType', 'ignoreDarkness', 'colorCycleSpeed'],
        },
        {
          name: 'distortion',
          label: 'Distortion & noise',
          type: 'folder',
          expanded: false,
          parameters: ['distortionStrength', 'noiseScale', 'phaseMult'],
        },
        {
          name: 'mask',
          label: 'Mask',
          type: 'folder',
          expanded: false,
          parameters: ['maskThreshold', 'invertMask'],
        },
      ],
      parameters: {
        textureStatus: {
          type: 'string',
          label: 'Mask status',
          default: 'Searching...',
          readonly: true,
          tooltip: 'Updated when the scene loads: whether any `_Iridescence` mask was found.',
        },
        intensity: {
          type: 'slider',
          label: 'Intensity',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.5,
          throttle: 100,
          tooltip: 'Strength of the iridescent color.',
        },
        alpha: {
          type: 'slider',
          label: 'Opacity',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.5,
          throttle: 100,
          tooltip: 'Master alpha for the additive overlay.',
        },
        flowSpeed: {
          type: 'slider',
          label: 'Flow speed',
          min: 0,
          max: 5,
          step: 0.01,
          default: 1.5,
          throttle: 100,
          tooltip: 'Screen-space scroll speed of the interference pattern.',
        },
        angle: {
          type: 'slider',
          label: 'Angle',
          min: 0,
          max: 360,
          step: 1,
          default: 0,
          throttle: 100,
          tooltip: 'Flow direction in degrees.',
        },
        parallaxStrength: {
          type: 'slider',
          label: 'Parallax strength',
          min: 0,
          max: 5,
          step: 0.01,
          default: 3.0,
          throttle: 100,
          tooltip: 'How much the pattern shifts with camera movement.',
        },
        noiseType: {
          type: 'list',
          label: 'Noise type',
          options: { 'Liquid (smooth)': 0, 'Glitter (grain)': 1 },
          default: 0,
          tooltip: 'Liquid = smoother bands; Glitter = sharper, grainier sparkle.',
        },
        ignoreDarkness: {
          type: 'slider',
          label: 'Ignore darkness',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.5,
          throttle: 100,
          tooltip: 'Higher = keep iridescence visible when the scene is dark or night-tinted.',
        },
        colorCycleSpeed: {
          type: 'slider',
          label: 'Color cycle speed',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.1,
          throttle: 100,
          tooltip: 'How fast hues shift over time.',
        },
        distortionStrength: {
          type: 'slider',
          label: 'Distortion strength',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.92,
          throttle: 100,
          tooltip: 'UV warp from the mask into the noise field.',
        },
        noiseScale: {
          type: 'slider',
          label: 'Noise scale',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.68,
          throttle: 100,
          tooltip: '0–1 UI mapped to internal noise frequency (higher = finer detail).',
        },
        phaseMult: {
          type: 'slider',
          label: 'Phase multiplier',
          min: 0.5,
          max: 6,
          step: 0.1,
          default: 4.0,
          throttle: 100,
          tooltip: 'Density of interference fringes.',
        },
        maskThreshold: {
          type: 'slider',
          label: 'Mask threshold',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.05,
          throttle: 100,
          tooltip: 'Minimum decoded mask strength to show iridescence; trims weak edges.',
        },
        invertMask: {
          type: 'boolean',
          label: 'Invert mask',
          default: false,
          tooltip: 'Off = brighter `_Iridescence` pixels = more shine (usual white-on-black paint). On = invert luminance (black = shine).',
        },
      },
      presets: {
        Calm: {
          flowSpeed: 0.55,
          colorCycleSpeed: 0.04,
          distortionStrength: 0.55,
          phaseMult: 3.2,
        },
        Vivid: {
          intensity: 0.82,
          flowSpeed: 2.1,
          colorCycleSpeed: 0.42,
          parallaxStrength: 3.8,
          phaseMult: 5.2,
        },
        Subtle: {
          intensity: 0.28,
          alpha: 0.32,
          flowSpeed: 0.9,
          colorCycleSpeed: 0.06,
          distortionStrength: 0.45,
        },
      },
    };
  }

  initialize() {
    if (this._initialized) return;
    const THREE = window.THREE;
    if (!THREE) return;
    this._buildFallbackTextures();
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
    this.params.textureStatus = 'Inactive (no _Iridescence mask)';
  }

  dispose() {
    this.clear();
    this._unregisterLightHooks();
    try { this._fallbackBlack?.dispose?.(); } catch (_) {}
    this._fallbackBlack = null;
    this._sharedUniforms = null;
    this._initialized = false;
    log.info('IridescenceEffectV2 disposed');
  }

  /**
   * Same contract as SpecularEffectV2: hide bus meshes when the effect is off or
   * params.enabled is false.
   * @private
   */
  _syncOverlayVisibility() {
    const visible = !!(this._enabled && this.params?.enabled !== false);
    for (const [, entry] of this._overlays) {
      const mesh = entry?.mesh;
      if (!mesh) continue;
      mesh.visible = visible;
    }
  }

  /** @private */
  _buildFallbackTextures() {
    const THREE = window.THREE;
    const blackData = new Uint8Array([0, 0, 0, 255]);
    this._fallbackBlack = new THREE.DataTexture(blackData, 1, 1, THREE.RGBAFormat);
    this._fallbackBlack.needsUpdate = true;
    this._fallbackBlack.minFilter = THREE.NearestFilter;
    this._fallbackBlack.magFilter = THREE.NearestFilter;
  }

  async populate(foundrySceneData) {
    if (!this._initialized) return;
    this.clear();
    this._syncOverlayVisibility();

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
        this._createOverlay('__bg_image__', 0, {
          maskUrl: bgResult.path, centerX, centerY, z, tileW: sceneW, tileH: sceneH, rotation: 0,
        });
        overlayCount++;
      }
    }

    const tileDocs = canvas?.scene?.tiles?.contents ?? [];
    for (const tileDoc of tileDocs) {
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;
      // Must match FloorRenderBus / SpecularEffectV2 exactly — Map keys are identity-
      // sensitive (number ≠ string). Coercing to String breaks _tiles.get() so attach
      // fails and overlays fall back to world space (wrong vs moving tiles).
      const tileKey = tileDoc?.id ?? tileDoc?._id;
      if (tileKey == null || tileKey === '') continue;

      const basePath = this._basePathNoExt(src);
      const result = await probeMaskFile(basePath, '_Iridescence');
      if (!result?.path) continue;

      const floorIndex = this._resolveFloorIndex(tileDoc, floors);
      const { dispW: tileW, dispH: tileH, signX: planeSignX, signY: planeSignY } = getTileBusPlaneSizeAndMirror(tileDoc);
      // V14+: (x,y) is the shape anchor; visual center uses anchorX/Y (matches FloorRenderBus).
      const { cx: cxf, cy: cyf } = getTileVisualCenterFoundryXY(tileDoc);
      const centerX = cxf;
      const centerY = worldH - cyf;
      const rotation = typeof tileDoc.rotation === 'number' ? (tileDoc.rotation * Math.PI) / 180 : 0;
      const z = GROUND_Z + floorIndex * Z_PER_FLOOR + IRIDESCENCE_Z_OFFSET;

      this._createOverlay(tileKey, floorIndex, {
        maskUrl: result.path, centerX, centerY, z, tileW, tileH, rotation, planeSignX, planeSignY,
      });
      overlayCount++;
    }

    this.params.hasIridescenceMask = overlayCount > 0;
    this.params.textureStatus = overlayCount > 0
      ? 'Ready (_Iridescence mask found)'
      : 'Inactive (no _Iridescence mask)';
    log.info(`IridescenceEffectV2 populated: ${overlayCount} overlay(s)`);
    this._syncOverlayVisibility();
  }

  update(timeInfo) {
    if (!this._initialized || !this._sharedUniforms) return;
    const u = this._sharedUniforms;

    u.uTime.value = timeInfo.elapsed;
    u.uEffectEnabled.value = resolveEffectEnabled(this);
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
    u.uMaskInvert.value = this.params.invertMask ? 1.0 : 0.0;

    this._updateEnvironmentUniforms();
    this._syncLightUniforms();

    this._syncOverlayVisibility();
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

    // Screen-space token mask: suppress iridescence where token silhouettes exist.
    try {
      const mm = window.MapShine?.maskManager;
      let tokenMaskTex = mm?.getTexture?.('tokenMask.screen') ?? null;
      if (!tokenMaskTex) {
        tokenMaskTex = window.MapShine?.lightingEffect?.tokenMaskTarget?.texture ?? null;
      }
      u.uTokenMask.value = tokenMaskTex || this._fallbackBlack;
      u.uHasTokenMask.value = tokenMaskTex ? 1.0 : 0.0;
    } catch (_) {
      u.uTokenMask.value = this._fallbackBlack;
      u.uHasTokenMask.value = 0.0;
    }
  }

  _createOverlay(tileKey, floorIndex, opts) {
    const THREE = window.THREE;
    const {
      maskUrl, centerX, centerY, z, tileW, tileH, rotation,
      planeSignX = 1, planeSignY = 1,
    } = opts;

    const perTileUniforms = {
      uIridescenceMask: { value: null },
    };
    const uniforms = { ...this._sharedUniforms, ...perTileUniforms };

    // Match SpecularEffectV2 bus overlays: additive pass, no depth test (bus tile
    // albedo also uses depthTest:false; depth-testing this quad hides it against
    // unrelated depth from tokens/walls).
    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: this._getVertexShader(),
      fragmentShader: this._getFragmentShader(),
      side: THREE.DoubleSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      fog: false,
    });

    const geometry = new THREE.PlaneGeometry(tileW, tileH);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `IridescenceV2_${tileKey}`;
    mesh.frustumCulled = false;
    mesh.scale.set(
      Number.isFinite(planeSignX) && planeSignX !== 0 ? planeSignX : 1,
      Number.isFinite(planeSignY) && planeSignY !== 0 ? planeSignY : 1,
      1,
    );

    try {
      const baseEntry = this._renderBus?._tiles?.get?.(tileKey);
      const baseOrder = Number(baseEntry?.mesh?.renderOrder);
      const isOverhead = !!(baseEntry?.root?.userData?.isOverhead ?? baseEntry?.mesh?.parent?.userData?.isOverhead);
      if (Number.isFinite(baseOrder)) {
        mesh.renderOrder = tileRelativeEffectOrder(baseOrder, floorIndex, isOverhead, 5);
      }
    } catch (_) {}

    // Match SpecularEffectV2: any bus tile entry may attach; parent resolves to
    // tileEntry.root || mesh.parent (see FloorRenderBus.addTileAttachedOverlay).
    const baseEntry = this._renderBus?._tiles?.get?.(tileKey);
    const canAttachToTileRoot = !!baseEntry && !String(tileKey).startsWith('__');
    let attached = false;
    if (canAttachToTileRoot && typeof this._renderBus?.addTileAttachedOverlay === 'function') {
      mesh.position.set(0, 0, IRIDESCENCE_Z_OFFSET);
      mesh.rotation.z = 0;
      attached = this._renderBus.addTileAttachedOverlay(tileKey, `${tileKey}_iridescence`, mesh, floorIndex) === true;
    }
    if (!attached) {
      mesh.position.set(centerX, centerY, z);
      mesh.rotation.z = rotation;
      this._renderBus.addEffectOverlay(`${tileKey}_iridescence`, mesh, floorIndex);
    }
    this._overlays.set(tileKey, { mesh, material, floorIndex });
    this._syncOverlayVisibility();

    const loader = new THREE.TextureLoader();
    loader.load(maskUrl, (tex) => {
      if (THREE.NoColorSpace !== undefined) tex.colorSpace = THREE.NoColorSpace;
      tex.flipY = true;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      const entry = this._overlays.get(tileKey);
      if (!entry) {
        try { tex.dispose(); } catch (_) {}
        return;
      }
      entry.material.uniforms.uIridescenceMask.value = tex;
    }, undefined, (err) => {
      log.warn(`IridescenceEffectV2: failed to load mask for ${tileKey}: ${maskUrl}`, err);
    });
  }

  _buildSharedUniforms() {
    const THREE = window.THREE;
    this._sharedUniforms = {
      uEffectEnabled: { value: resolveEffectEnabled(this) },
      uTokenMask: { value: this._fallbackBlack },
      uHasTokenMask: { value: 0.0 },
      uTime: { value: 0.0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uIntensity: { value: this.params.intensity },
      uAlpha: { value: this.params.alpha },
      uDistortionStrength: { value: this.params.distortionStrength },
      uNoiseScale: { value: this._mapNoiseScale(this.params.noiseScale, this.params.noiseType) },
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
      uMaskInvert: { value: this.params.invertMask ? 1.0 : 0.0 },
      uAmbientDaylight: { value: new THREE.Color(1.0, 1.0, 1.0) },
      uAmbientDarkness: { value: new THREE.Color(0.14, 0.14, 0.28) },
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
      uniform float uMaskInvert;
      uniform vec3 uAmbientDaylight;
      uniform vec3 uAmbientDarkness;
      uniform int numLights;
      uniform vec3 lightPosition[${MAX_LIGHTS}];
      uniform vec3 lightColor[${MAX_LIGHTS}];
      uniform vec4 lightConfig[${MAX_LIGHTS}];

      varying vec2 vUv;
      varying vec3 vWorldPosition;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
      }

      // Luminance × α only. Do NOT use a separate “alpha-only” branch that sets rawMask=a
      // when RGB≈0 — opaque black padding would read full strength while painted props
      // (non-black RGB) went through luminance and looked inverted vs padding.
      void main() {
        if (!uEffectEnabled) discard;

        vec4 s = texture2D(uIridescenceMask, vUv);
        float lum = clamp(dot(s.rgb, vec3(0.299, 0.587, 0.114)), 0.0, 1.0);
        float peak = max(max(s.r, s.g), s.b);
        float rgbBright = max(lum, peak);
        float a = clamp(s.a, 0.0, 1.0);
        const float A_EPS = 0.001;

        if (a < A_EPS) discard;

        float t = rgbBright;
        if (uMaskInvert > 0.5) t = 1.0 - t;
        float rawMask = t * a;
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
