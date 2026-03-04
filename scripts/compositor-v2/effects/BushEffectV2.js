/**
 * @fileoverview V2 Bush Effect — animated bush canopy overlay driven by _Bush masks.
 *
 * Archetype: Bus Overlay (Per-Tile Mesh)
 * - One ShaderMaterial overlay per tile/background with a _Bush mask.
 * - Overlay meshes are registered into FloorRenderBus so floor visibility is handled by the bus.
 * - No dependencies on V1 EffectBase / EffectMaskRegistry / TileEffectBindingManager.
 */

import { createLogger } from '../../core/log.js';
import { probeMaskFile } from '../../assets/loader.js';
import { tileHasLevelsRange, readTileLevelsFlags } from '../../foundry/levels-scene-flags.js';
import { weatherController } from '../../core/WeatherController.js';

const log = createLogger('BushEffectV2');

const GROUND_Z = 1000;
const BUSH_Z_OFFSET = 0.12; // above albedo within same floor band

export class BushEffectV2 {
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

    /** @type {THREE.TextureLoader|null} */
    this._loader = null;

    /**
     * Overlay entries keyed by tileId.
     * @type {Map<string, {mesh: THREE.Mesh, material: THREE.ShaderMaterial, floorIndex: number}>}
     */
    this._overlays = new Map();

    /** @type {Set<string>} */
    this._negativeCache = new Set();

    /** @type {object|null} */
    this._sharedUniforms = null;

    // Temporal state (smoothed wind coupling)
    this._currentWindSpeed = 0.0;
    this._lastFrameTime = 0.0;

    // Public params (mirrors V1 schema / defaults)
    this.params = {
      enabled: true,
      intensity: undefined,

      // -- Wind Physics --
      windSpeedGlobal: 0.04,
      windRampSpeed: 2.93,
      gustFrequency: 0.01,
      gustSpeed: 0.52463,

      // -- Bush Movement --
      branchBend: 0.037,
      elasticity: 5.0,

      // -- Leaf Flutter --
      flutterIntensity: 0.0014,
      flutterSpeed: 1.85362,
      flutterScale: 0.01133,

      // -- Color --
      exposure: 0.0,
      brightness: 0.0,
      contrast: 1.0,
      saturation: 1.1,
      temperature: 0.0,
      tint: 0.0,

      // Shadow params retained for UI parity (not applied in V2 yet)
      shadowOpacity: 0.4,
      shadowLength: 0.02,
      shadowSoftness: 5.0,
    };

    log.debug('BushEffectV2 created');
  }

  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    for (const entry of this._overlays.values()) {
      entry.mesh.visible = this._enabled;
    }
    if (this._sharedUniforms?.uEffectEnabled) {
      this._sharedUniforms.uEffectEnabled.value = this._enabled;
    }
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'bush-phys',
          label: 'Wind Physics',
          type: 'inline',
          parameters: ['windSpeedGlobal', 'windRampSpeed', 'branchBend', 'elasticity']
        },
        {
          name: 'bush-flutter',
          label: 'Leaf Flutter',
          type: 'inline',
          parameters: ['flutterIntensity', 'flutterSpeed', 'flutterScale']
        },
        {
          name: 'bush-color',
          label: 'Color',
          type: 'folder',
          parameters: ['exposure', 'brightness', 'contrast', 'saturation', 'temperature', 'tint']
        },
        {
          name: 'bush-shadow',
          label: 'Shadow',
          type: 'inline',
          parameters: ['shadowOpacity', 'shadowLength', 'shadowSoftness']
        }
      ],
      parameters: {
        intensity: { type: 'slider', min: 0.0, max: 2.0, default: undefined },
        windSpeedGlobal: { type: 'slider', label: 'Wind Strength', min: 0.0, max: 3.0, default: 0.04 },
        windRampSpeed: { type: 'slider', label: 'Wind Responsiveness', min: 0.1, max: 10.0, default: 2.93 },
        branchBend: { type: 'slider', label: 'Branch Bend', min: 0.0, max: 0.05, step: 0.001, default: 0.037 },
        elasticity: { type: 'slider', label: 'Springiness', min: 0.5, max: 5.0, default: 5.0 },
        flutterIntensity: { type: 'slider', label: 'Leaf Flutter Amount', min: 0.0, max: 0.005, step: 0.0001, default: 0.0014 },
        flutterSpeed: { type: 'slider', label: 'Leaf Flutter Speed', min: 1.0, max: 20.0, default: 1.85 },
        flutterScale: { type: 'slider', label: 'Leaf Cluster Size', min: 0.005, max: 0.1, default: 0.01 },
        exposure: { type: 'slider', min: -2.0, max: 2.0, default: 0.0 },
        brightness: { type: 'slider', min: -0.5, max: 0.5, default: 0.0 },
        contrast: { type: 'slider', min: 0.5, max: 2.0, default: 1.0 },
        saturation: { type: 'slider', min: 0.0, max: 2.0, default: 1.1 },
        temperature: { type: 'slider', min: -1.0, max: 1.0, default: 0.0 },
        tint: { type: 'slider', min: -1.0, max: 1.0, default: 0.0 },
        shadowOpacity: { type: 'slider', label: 'Shadow Opacity', min: 0.0, max: 1.0, default: 0.4 },
        shadowLength: { type: 'slider', label: 'Shadow Length', min: 0.0, max: 0.1, default: 0.02 },
        shadowSoftness: { type: 'slider', label: 'Shadow Softness', min: 0.5, max: 5.0, default: 5.0 }
      }
    };
  }

  initialize() {
    const THREE = window.THREE;
    if (!THREE) return;
    this._loader = new THREE.TextureLoader();
    this._buildSharedUniforms();
    this._initialized = true;
    log.info('BushEffectV2 initialized');
  }

  async populate(foundrySceneData) {
    if (!this._initialized) return;
    this.clear();

    const floors = window.MapShine?.floorStack?.getFloors() ?? [];
    const worldH = Number(foundrySceneData?.height) || 0;

    // Background first
    const bgSrc = canvas?.scene?.background?.src ?? '';
    if (bgSrc) {
      const basePath = bgSrc.replace(/\.[^.]+$/, '');
      const url = await this._probeMask(basePath, '_Bush');
      if (url) {
        const centerX = Number(foundrySceneData?.sceneX ?? 0) + Number(foundrySceneData?.sceneWidth ?? 0) / 2;
        const centerY = worldH - (Number(foundrySceneData?.sceneY ?? 0) + Number(foundrySceneData?.sceneHeight ?? 0) / 2);
        const tileW = Number(foundrySceneData?.sceneWidth ?? 0);
        const tileH = Number(foundrySceneData?.sceneHeight ?? 0);
        const z = GROUND_Z - 1 + BUSH_Z_OFFSET;
        this._createOverlay('__bg_image__', 0, { url, centerX, centerY, z, tileW, tileH, rotation: 0 });
      }
    }

    // Tiles
    const tileDocs = canvas?.scene?.tiles?.contents ?? [];
    for (const tileDoc of tileDocs) {
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;

      const basePath = src.replace(/\.[^.]+$/, '');
      const url = await this._probeMask(basePath, '_Bush');
      if (!url) continue;

      const floorIndex = this._resolveFloorIndex(tileDoc, floors);
      const tileW = Number(tileDoc?.width ?? 0);
      const tileH = Number(tileDoc?.height ?? 0);
      const centerX = Number(tileDoc?.x ?? 0) + tileW / 2;
      const centerY = worldH - (Number(tileDoc?.y ?? 0) + tileH / 2);
      const z = GROUND_Z + floorIndex + BUSH_Z_OFFSET;
      const rotation = typeof tileDoc?.rotation === 'number' ? (tileDoc.rotation * Math.PI) / 180 : 0;
      const tileId = tileDoc.id ?? tileDoc._id;
      if (!tileId) continue;

      this._createOverlay(tileId, floorIndex, { url, centerX, centerY, z, tileW, tileH, rotation });
    }

    log.info(`BushEffectV2 populated: ${this._overlays.size} overlays`);
  }

  update(timeInfo) {
    if (!this._enabled || !this._initialized) return;

    const time = Number(timeInfo?.time ?? 0);
    const delta = Number(timeInfo?.delta ?? 0);

    // Wind coupling — use WeatherController's smoothed state.
    const weather = weatherController?.currentState;
    const windDir = weather?.windDirection;
    const windSpeed01 = Number(weather?.windSpeed ?? 0);

    // Smooth wind speed to avoid snapping.
    const ramp = Math.max(0.001, Number(this.params.windRampSpeed ?? 1));
    const lerpT = Math.min(1.0, delta * ramp);
    this._currentWindSpeed = this._currentWindSpeed + (windSpeed01 - this._currentWindSpeed) * lerpT;

    // Update shared uniforms.
    if (this._sharedUniforms) {
      this._sharedUniforms.uTime.value = time;
      if (windDir && typeof windDir.x === 'number' && typeof windDir.y === 'number') {
        this._sharedUniforms.uWindDir.value.set(windDir.x, windDir.y);
      }
      this._sharedUniforms.uWindSpeed.value = this._currentWindSpeed;

      // Params
      this._sharedUniforms.uIntensity.value = (this.params.intensity ?? 1.0);
      this._sharedUniforms.uWindSpeedGlobal.value = this.params.windSpeedGlobal;
      this._sharedUniforms.uGustFrequency.value = this.params.gustFrequency;
      this._sharedUniforms.uGustSpeed.value = this.params.gustSpeed;
      this._sharedUniforms.uBranchBend.value = this.params.branchBend;
      this._sharedUniforms.uElasticity.value = this.params.elasticity;
      this._sharedUniforms.uFlutterIntensity.value = this.params.flutterIntensity;
      this._sharedUniforms.uFlutterSpeed.value = this.params.flutterSpeed;
      this._sharedUniforms.uFlutterScale.value = this.params.flutterScale;

      this._sharedUniforms.uExposure.value = this.params.exposure;
      this._sharedUniforms.uBrightness.value = this.params.brightness;
      this._sharedUniforms.uContrast.value = this.params.contrast;
      this._sharedUniforms.uSaturation.value = this.params.saturation;
      this._sharedUniforms.uTemperature.value = this.params.temperature;
      this._sharedUniforms.uTint.value = this.params.tint;
    }

    this._lastFrameTime = time;
  }

  onFloorChange(_maxFloorIndex) {
    // Bus overlay visibility is handled by FloorRenderBus.setVisibleFloors().
  }

  wantsContinuousRender() {
    return this._enabled && this._initialized && this._overlays.size > 0;
  }

  onResize(_w, _h) {
    // No RTs.
  }

  clear() {
    for (const [tileId, entry] of this._overlays) {
      this._renderBus.removeEffectOverlay(`${tileId}_bush`);
      entry.material.dispose();
      entry.mesh.geometry.dispose();
      const tex = entry.material.uniforms.uBushMask?.value;
      if (tex && tex.dispose) {
        try { tex.dispose(); } catch (_) {}
      }
    }
    this._overlays.clear();
  }

  dispose() {
    this.clear();
    this._loader = null;
    this._sharedUniforms = null;
    this._initialized = false;
    log.info('BushEffectV2 disposed');
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  _buildSharedUniforms() {
    const THREE = window.THREE;
    this._sharedUniforms = {
      uEffectEnabled: { value: this._enabled },
      uBushMask: { value: null },
      uTime: { value: 0.0 },
      uWindDir: { value: new THREE.Vector2(1.0, 0.0) },
      uWindSpeed: { value: 0.0 },

      uIntensity: { value: (this.params.intensity ?? 1.0) },
      uWindSpeedGlobal: { value: this.params.windSpeedGlobal },
      uGustFrequency: { value: this.params.gustFrequency },
      uGustSpeed: { value: this.params.gustSpeed },
      uBranchBend: { value: this.params.branchBend },
      uElasticity: { value: this.params.elasticity },
      uFlutterIntensity: { value: this.params.flutterIntensity },
      uFlutterSpeed: { value: this.params.flutterSpeed },
      uFlutterScale: { value: this.params.flutterScale },

      uExposure: { value: this.params.exposure },
      uBrightness: { value: this.params.brightness },
      uContrast: { value: this.params.contrast },
      uSaturation: { value: this.params.saturation },
      uTemperature: { value: this.params.temperature },
      uTint: { value: this.params.tint },
    };
  }

  async _probeMask(basePath, suffix) {
    if (!basePath || this._negativeCache.has(basePath)) return null;
    try {
      const res = await probeMaskFile(basePath, suffix);
      if (res?.path) return res.path;
      this._negativeCache.add(basePath);
      return null;
    } catch (err) {
      this._negativeCache.add(basePath);
      return null;
    }
  }

  _resolveFloorIndex(tileDoc, floors) {
    if (!floors || floors.length <= 1) return 0;
    if (tileHasLevelsRange(tileDoc)) {
      const flags = readTileLevelsFlags(tileDoc);
      const mid = (Number(flags.rangeBottom) + Number(flags.rangeTop)) / 2;
      for (let i = 0; i < floors.length; i++) {
        if (mid >= floors[i].elevationMin && mid <= floors[i].elevationMax) return i;
      }
    }
    const elev = Number.isFinite(Number(tileDoc?.elevation)) ? Number(tileDoc.elevation) : 0;
    for (let i = 0; i < floors.length; i++) {
      if (elev >= floors[i].elevationMin && elev <= floors[i].elevationMax) return i;
    }
    return 0;
  }

  _createOverlay(tileId, floorIndex, opts) {
    const THREE = window.THREE;
    if (!THREE || !this._sharedUniforms) return;

    const { url, centerX, centerY, z, tileW, tileH, rotation } = opts;

    const uniforms = {
      ...this._sharedUniforms,
      uBushMask: { value: null },
    };

    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: /* glsl */`
        varying vec2 vUv;
        varying vec2 vWorldPos;
        void main() {
          vUv = uv;
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldPos = worldPos.xy;
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uBushMask;
        uniform float uTime;
        uniform vec2  uWindDir;
        uniform float uWindSpeed;
        uniform float uIntensity;

        uniform float uWindSpeedGlobal;
        uniform float uGustFrequency;
        uniform float uGustSpeed;
        uniform float uBranchBend;
        uniform float uElasticity;
        uniform float uFlutterIntensity;
        uniform float uFlutterSpeed;
        uniform float uFlutterScale;

        uniform float uExposure;
        uniform float uBrightness;
        uniform float uContrast;
        uniform float uSaturation;
        uniform float uTemperature;
        uniform float uTint;

        varying vec2 vUv;
        varying vec2 vWorldPos;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }

        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash(i + vec2(0.0,0.0)), hash(i + vec2(1.0,0.0)), u.x),
            mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), u.x),
            u.y
          );
        }

        float msLuminance(vec3 c) {
          return dot(c, vec3(0.2126, 0.7152, 0.0722));
        }

        vec3 applyCC(vec3 color) {
          color *= pow(2.0, uExposure);
          float t = uTemperature;
          float g = uTint;
          color.r += t * 0.1; color.b -= t * 0.1; color.g += g * 0.1;
          color += vec3(uBrightness);
          color = (color - 0.5) * uContrast + 0.5;
          float l = msLuminance(color);
          color = mix(vec3(l), color, uSaturation);
          return color;
        }

        void main() {
          vec2 windDir = normalize(uWindDir);
          if (length(windDir) < 0.01) windDir = vec2(1.0, 0.0);

          float speed = uWindSpeed * uWindSpeedGlobal;
          float ambientMotion = 0.1;
          float effectiveSpeed = ambientMotion + speed;

          vec2 gustPos = vWorldPos * uGustFrequency;
          vec2 scroll = windDir * uTime * uGustSpeed * effectiveSpeed;
          float gustNoise = noise(gustPos - scroll);
          float gustStrength = smoothstep(0.2, 0.8, gustNoise);

          vec2 perpDir = vec2(-windDir.y, windDir.x);
          float orbitPhase = uTime * uElasticity + (gustNoise * 5.0);
          float orbitSway = sin(orbitPhase);

          float pushMagnitude = gustStrength * uBranchBend * effectiveSpeed;
          float swayMagnitude = orbitSway * (uBranchBend * 0.4) * effectiveSpeed * (0.5 + 0.5 * gustStrength);

          float noiseVal = noise(vWorldPos * uFlutterScale);
          float flutterPhase = uTime * uFlutterSpeed * effectiveSpeed + noiseVal * 6.28;
          float flutter = sin(flutterPhase);
          float flutterMagnitude = flutter * uFlutterIntensity * (0.5 + 0.5 * gustStrength);

          vec2 distortion = (windDir * pushMagnitude)
                          + (perpDir * swayMagnitude)
                          + vec2(flutter, flutter) * flutterMagnitude;

          vec4 bushSample = texture2D(uBushMask, vUv - distortion);

          float a = bushSample.a * uIntensity;
          if (a <= 0.001) discard;

          vec3 color = applyCC(bushSample.rgb);
          gl_FragColor = vec4(color, clamp(a, 0.0, 1.0));
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });

    const geometry = new THREE.PlaneGeometry(tileW, tileH);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `BushV2_${tileId}`;
    mesh.frustumCulled = false;
    mesh.position.set(centerX, centerY, z);
    mesh.rotation.z = rotation;

    // Tie render order to base tile when possible.
    try {
      const baseEntry = this._renderBus?._tiles?.get?.(tileId);
      const baseOrder = Number(baseEntry?.mesh?.renderOrder);
      if (Number.isFinite(baseOrder)) mesh.renderOrder = baseOrder + 2;
    } catch (_) {}

    this._renderBus.addEffectOverlay(`${tileId}_bush`, mesh, floorIndex);
    this._overlays.set(tileId, { mesh, material, floorIndex });

    // Load mask texture.
    this._loader.load(url, (tex) => {
      tex.flipY = true;
      tex.needsUpdate = true;
      if (this._overlays.has(tileId)) {
        material.uniforms.uBushMask.value = tex;
      } else {
        try { tex.dispose(); } catch (_) {}
      }
    }, undefined, (err) => {
      log.warn(`BushEffectV2: failed to load mask for ${tileId}: ${url}`, err);
    });
  }
}
