import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { weatherController } from '../core/WeatherController.js';

const log = createLogger('TreeEffect');

/**
 * Animated Tree effect (High Canopy)
 * Renders the `_Tree` RGBA texture as a high-level surface overlay.
 * 
 * Key Differences from BushEffect:
 * - Placed ABOVE overhead layers (z=25)
 * - Does NOT receive shadows (canopy is top-most)
 * - Casts shadows onto everything below (Ground, Overhead, Bushes)
 */
export class TreeEffect extends EffectBase {
  constructor() {
    super('tree', RenderLayers.SURFACE_EFFECTS, 'low');

    this.priority = 12; // Higher priority than bushes
    this.alwaysRender = false;

    /**
     * Per-floor cached state. Keyed by FloorBand.key. Populated lazily by
     * bindFloorMasks(). Holds per-floor tree mask textures and billboard
     * instance data derived from each floor's tree mask.
     * @type {Map<string, object>}
     */
    this._floorStates = new Map();

    this.baseMesh = null;
    this.mesh = null;
    this.treeMask = null;
    this.material = null;
    this.scene = null;
    this.shadowScene = null;
    this.shadowMesh = null;
    this.shadowMaterial = null;
    this.shadowTarget = null;

    this._enabled = true;

    this._hoverHidden = false;
    this._hoverFade = 1.0;

    this._alphaMask = null;
    this._alphaMaskWidth = 0;
    this._alphaMaskHeight = 0;

    // Internal state for smoothing
    this._currentWindSpeed = 0.0;
    this._lastFrameTime = 0.0;

    this.params = {
      enabled: true,
      intensity: undefined,

      // -- Wind Physics --
      windSpeedGlobal: 0.36304,  // Multiplier for actual game wind speed (slightly stronger than bushes)
      windRampSpeed: 1.29804,    // Inertia: heavier canopy, slower response
      gustFrequency: 0.00221,    // Larger, more spread-out gusts for tall trees
      gustSpeed: 0.15,           // How fast the noise field scrolls

      // -- Tree Movement --
      branchBend: 0.033,         // Tree trunks bend more in strong wind
      elasticity: 5.0,           // Heavier inertia than bushes

      // -- Leaf Flutter --
      flutterIntensity: 0.0012,  // Subtle flutter for high canopy
      flutterSpeed: 1.5,         // Slightly slower flutter than bushes
      flutterScale: 0.02,        // Slightly larger clusters (bigger leaf groups)

      // -- Color --
      exposure: 0.0,
      brightness: 0.0,
      contrast: 1.0,
      saturation: 1.1,
      temperature: 0.0,
      tint: 0.0,

      // Shadow (cast onto scene via LightingEffect)
      shadowOpacity: 0.3,
      shadowLength: 0.08,
      shadowSoftness: 10.0
    };
    
    // PERFORMANCE: Reusable objects to avoid per-frame allocations
    this._tempSize = null; // Lazy init when THREE is available

    /** @type {function|null} Unsubscribe from EffectMaskRegistry */
    this._registryUnsub = null;

    /**
     * Per-tile overlay meshes created by the TileBindableEffect interface.
     * Key: tileId, Value: {mesh, material, sprite}
     * @type {Map<string, {mesh: THREE.Mesh, material: THREE.ShaderMaterial, sprite: THREE.Object3D}>}
     */
    this._tileOverlays = new Map();

    /**
     * All per-tile overlay materials — kept in sync with params in update().
     * @type {Set<THREE.ShaderMaterial>}
     */
    this._tileOverlayMaterials = new Set();
  }

  _resetTemporalState() {
    this._currentWindSpeed = 0.0;
    this._lastFrameTime = 0.0;
    this._hoverHidden = false;
    this._hoverFade = 1.0;
  }

  _clearAlphaMaskCache() {
    this._alphaMask = null;
    this._alphaMaskWidth = 0;
    this._alphaMaskHeight = 0;
  }

  /**
   * Bind floor-specific mask data before a floor's render pass.
   * @param {object} bundle - Mask bundle for this floor
   * @param {string} floorKey - Stable floor key from FloorBand.key
   */
  bindFloorMasks(bundle, floorKey) {
    if (!bundle) return;

    const masks = bundle.masks ?? [];
    const treeEntry = masks.find(m => m.id === 'tree' || m.type === 'tree');
    const floorMaskTex = treeEntry?.texture ?? null;

    // Restore from cache if mask reference hasn't changed — O(1) path.
    const cached = this._floorStates.get(floorKey);
    if (cached && cached.treeMask === floorMaskTex) {
      if (this.treeMask !== cached.treeMask) {
        this.treeMask = cached.treeMask;
        this._deriveAlpha = cached.deriveAlpha;
        this._applyTreeMaskUniforms(cached.treeMask, cached.deriveAlpha);
        if (this.mesh) this.mesh.visible = !!cached.treeMask && this._enabled;
      }
      return;
    }

    // First visit or mask changed: update state and uniforms.
    const prevMask = this.treeMask;
    this.treeMask = floorMaskTex;
    if (floorMaskTex !== prevMask) this._clearAlphaMaskCache();

    const deriveAlpha = floorMaskTex ? this._needsDerivedAlpha(floorMaskTex) : false;
    this._deriveAlpha = deriveAlpha;

    if (floorMaskTex && this.baseMesh) {
      if (!this.mesh && this.scene) {
        // First floor that has trees: create the mesh now.
        this._createMesh();
        if (this.shadowScene) this._createShadowMesh();
      } else {
        // Mesh already exists: swap uniforms without GPU-side rebuild.
        this._applyTreeMaskUniforms(floorMaskTex, deriveAlpha);
        if (this.mesh) this.mesh.visible = this._enabled;
      }
    } else if (this.mesh) {
      // No tree mask on this floor: hide mesh.
      this.mesh.visible = false;
    }

    this._floorStates.set(floorKey, { treeMask: floorMaskTex, deriveAlpha });
  }

  /**
   * Update uTreeMask + uDeriveAlpha on the main and shadow materials.
   * Called by bindFloorMasks() on floors after the first, where the mesh
   * geometry is already in the scene and only the texture needs to change.
   * @param {THREE.Texture|null} tex
   * @param {boolean} deriveAlpha
   * @private
   */
  _applyTreeMaskUniforms(tex, deriveAlpha) {
    if (this.material?.uniforms) {
      if (this.material.uniforms.uTreeMask) this.material.uniforms.uTreeMask.value = tex;
      if (this.material.uniforms.uDeriveAlpha) this.material.uniforms.uDeriveAlpha.value = deriveAlpha ? 1.0 : 0.0;
    }
    if (this.shadowMaterial?.uniforms?.uTreeMask) {
      this.shadowMaterial.uniforms.uTreeMask.value = tex;
    }
  }

  /**
   * Release GPU resources for a specific floor's cached state.
   * @param {string} floorKey
   */
  disposeFloorState(floorKey) {
    const state = this._floorStates.get(floorKey);
    if (!state) return;
    // Mask textures are owned by the compositor, not by us — don't dispose them here.
    this._floorStates.delete(floorKey);
  }

  dispose() {
    for (const key of this._floorStates.keys()) {
      this.disposeFloorState(key);
    }
    this._floorStates.clear();
    if (this._registryUnsub) { this._registryUnsub(); this._registryUnsub = null; }

    // Dispose all per-tile overlays.
    for (const [tileId] of this._tileOverlays) {
      try { this.unbindTileSprite(tileId); } catch (_) {}
    }
    this._tileOverlays.clear();
    this._tileOverlayMaterials.clear();

    try {
      if (this.mesh && this.scene) {
        this.scene.remove(this.mesh);
      }
      this.mesh = null;

      if (this.shadowMesh && this.shadowScene) {
        this.shadowScene.remove(this.shadowMesh);
      }
      this.shadowMesh = null;

      if (this.material) {
        this.material.dispose();
      }
      this.material = null;

      if (this.shadowMaterial) {
        this.shadowMaterial.dispose();
      }
      this.shadowMaterial = null;

      if (this.shadowTarget) {
        this.shadowTarget.dispose();
      }
      this.shadowTarget = null;

      this.shadowScene = null;
      this.scene = null;
      this.camera = null;
      this.renderer = null;
      this.baseMesh = null;
      this.treeMask = null;

      this._tempSize = null;
      this._clearAlphaMaskCache();
      this._resetTemporalState();
    } catch (e) {
      // Keep dispose resilient during scene teardown
    }
  }

  _ensureAlphaMask() {
    if (!this.treeMask || !this.treeMask.image || this._alphaMask) return;

    try {
      const image = this.treeMask.image;
      let width = image.width;
      let height = image.height;
      if (!width || !height) return;

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.drawImage(image, 0, 0, width, height);
      const imgData = ctx.getImageData(0, 0, width, height);
      this._alphaMask = imgData.data;
      this._alphaMaskWidth = width;
      this._alphaMaskHeight = height;
    } catch (e) {
      // If anything fails, leave mask null and fall back to simple hit test.
      this._alphaMask = null;
      this._alphaMaskWidth = 0;
      this._alphaMaskHeight = 0;
    }
  }

  isUvOpaque(uv) {
    if (!uv) return true;
    this._ensureAlphaMask();
    if (!this._alphaMask || !this._alphaMaskWidth || !this._alphaMaskHeight) return true;

    let u = uv.x;
    let v = uv.y;
    if (u < 0 || u > 1 || v < 0 || v > 1) return false;

    const x = Math.floor(u * (this._alphaMaskWidth - 1));
    const y = Math.floor(v * (this._alphaMaskHeight - 1));
    const index = (y * this._alphaMaskWidth + x) * 4;

    if (this._deriveAlpha) {
      // Mirror the shader's derived-alpha logic on the CPU side:
      // white/desaturated background → transparent, colored content → opaque.
      const r = this._alphaMask[index] / 255;
      const g = this._alphaMask[index + 1] / 255;
      const b = this._alphaMask[index + 2] / 255;
      const lum = r * 0.2126 + g * 0.7152 + b * 0.0722;
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const chroma = maxC - minC;
      // High luminance + low chroma = background
      const isBright = lum > 0.85;
      const isDesaturated = chroma < 0.06;
      return !(isBright && isDesaturated);
    }

    const alpha = this._alphaMask[index + 3] / 255;
    return alpha > 0.5;
  }

  setHoverHidden(hidden) {
    this._hoverHidden = !!hidden;
  }

  getHoverFade() {
    return this._hoverFade;
  }

  get enabled() { return this._enabled; }
  set enabled(value) {
    this._enabled = !!value;
    if (this.mesh) this.mesh.visible = !!value && !!this.treeMask;
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'tree-phys',
          label: 'Wind Physics',
          type: 'inline',
          parameters: ['windSpeedGlobal', 'windRampSpeed', 'branchBend', 'elasticity']
        },
        {
          name: 'tree-flutter',
          label: 'Leaf Flutter',
          type: 'inline',
          parameters: ['flutterIntensity', 'flutterSpeed', 'flutterScale']
        },
        {
          name: 'tree-color',
          label: 'Color',
          type: 'folder',
          parameters: ['exposure', 'brightness', 'contrast', 'saturation', 'temperature', 'tint']
        },
        {
          name: 'tree-shadow',
          label: 'Shadow',
          type: 'inline',
          parameters: ['shadowOpacity', 'shadowLength', 'shadowSoftness']
        }
      ],
      parameters: {
        intensity: { type: 'slider', min: 0.0, max: 2.0, default: 1.0 },
        windSpeedGlobal: { type: 'slider', label: 'Wind Strength', min: 0.0, max: 3.0, default: 0.36304 },
        windRampSpeed: { type: 'slider', label: 'Wind Responsiveness', min: 0.1, max: 10.0, default: 1.29804 },
        branchBend: { type: 'slider', label: 'Branch Bend', min: 0.0, max: 0.1, step: 0.001, default: 0.033 },
        elasticity: { type: 'slider', label: 'Springiness', min: 0.5, max: 5.0, default: 5.0 },
        flutterIntensity: { type: 'slider', label: 'Leaf Flutter Amount', min: 0.0, max: 0.005, step: 0.0001, default: 0.0012 },
        flutterSpeed: { type: 'slider', label: 'Leaf Flutter Speed', min: 1.0, max: 20.0, default: 1.5 },
        flutterScale: { type: 'slider', label: 'Leaf Cluster Size', min: 0.005, max: 0.1, default: 0.02 },
        exposure: { type: 'slider', min: -2.0, max: 2.0, default: 0.0 },
        brightness: { type: 'slider', min: -0.5, max: 0.5, default: 0.0 },
        contrast: { type: 'slider', min: 0.5, max: 2.0, default: 1.0 },
        saturation: { type: 'slider', min: 0.0, max: 2.0, default: 1.1 },
        temperature: { type: 'slider', min: -1.0, max: 1.0, default: 0.0 },
        tint: { type: 'slider', min: -1.0, max: 1.0, default: 0.0 },
        shadowOpacity: { type: 'slider', label: 'Shadow Opacity', min: 0.0, max: 1.0, default: 0.3 },
        shadowLength: { type: 'slider', label: 'Shadow Length', min: 0.0, max: 0.2, default: 0.08 },
        shadowSoftness: { type: 'slider', label: 'Shadow Softness', min: 0.5, max: 10.0, default: 10.0 }
      }
    };
  }

  _createShadowMesh() {
    const THREE = window.THREE;
    if (!THREE || !this.baseMesh || !this.treeMask) return;

    if (this.shadowMesh && this.shadowScene) {
      this.shadowScene.remove(this.shadowMesh);
      this.shadowMesh = null;
    }
    if (this.shadowMaterial) {
      this.shadowMaterial.dispose();
      this.shadowMaterial = null;
    }

    this.shadowMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTreeMask: { value: this.treeMask },
        uTime: { value: 0.0 },
        uWindDir: { value: new THREE.Vector2(1.0, 0.0) },
        uWindSpeed: { value: 0.0 },

        uWindSpeedGlobal: { value: this.params.windSpeedGlobal },
        uGustFrequency: { value: this.params.gustFrequency },
        uGustSpeed: { value: this.params.gustSpeed },
        uBranchBend: { value: this.params.branchBend },
        uElasticity: { value: this.params.elasticity },
        uFlutterIntensity: { value: this.params.flutterIntensity },
        uFlutterSpeed: { value: this.params.flutterSpeed },
        uFlutterScale: { value: this.params.flutterScale },

        uShadowOpacity: { value: 1.0 },
        uShadowLength: { value: this.params.shadowLength },
        uShadowSoftness: { value: this.params.shadowSoftness },

        uResolution: { value: new THREE.Vector2(1024, 1024) },
        uSunDir: { value: new THREE.Vector2(0.0, 1.0) },
        uTexelSize: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
        uZoom: { value: 1.0 },
        uHoverFade: { value: 1.0 }
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec2 vWorldPos;

        void main() {
          vUv = uv;
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldPos = worldPos.xy;
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: `
        uniform sampler2D uTreeMask;
        uniform float uTime;
        uniform vec2  uWindDir;
        uniform float uWindSpeed;

        uniform float uWindSpeedGlobal;
        uniform float uGustFrequency;
        uniform float uGustSpeed;
        uniform float uBranchBend;
        uniform float uElasticity;
        uniform float uFlutterIntensity;
        uniform float uFlutterSpeed;
        uniform float uFlutterScale;

        uniform float uShadowOpacity;
        uniform float uShadowLength;
        uniform float uShadowSoftness;

        uniform vec2 uResolution;
        uniform vec2 uTexelSize;
        uniform float uHoverFade;

        varying vec2 vUv;
        varying vec2 vWorldPos;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }

        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i + vec2(0.0,0.0)), hash(i + vec2(1.0,0.0)), u.x),
                     mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), u.x), u.y);
        }

        // Extract effective alpha, handling textures without a real alpha channel.
        // When the raw alpha is fully opaque AND the pixel is bright + desaturated
        // (white/gray background), return 0 so the pixel is treated as transparent.
        float safeAlpha(vec4 s) {
          float a = s.a;
          if (a > 0.99) {
            float lum    = dot(s.rgb, vec3(0.2126, 0.7152, 0.0722));
            float maxC   = max(s.r, max(s.g, s.b));
            float minC   = min(s.r, min(s.g, s.b));
            float chroma = maxC - minC;
            // Catch anti-aliased edges (tree color blended with white bg)
            // by using a wide luminance range and generous chroma tolerance.
            float bgMask = smoothstep(0.45, 0.85, lum)
                         * (1.0 - smoothstep(0.0, 0.15, chroma));
            a *= (1.0 - bgMask);
          }
          return a;
        }

        void main() {
          // --- Wind / Tree motion ---
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

          // Sample projected tree alpha (shadow source)
          vec4 treeSample = texture2D(uTreeMask, vUv - distortion);
          float a = safeAlpha(treeSample);
          
          float baseShadow = clamp(a * uShadowOpacity, 0.0, 1.0);

          float accum = 0.0;
          float weightSum = 0.0;
          float blurScale = max(uShadowSoftness, 0.5);
          vec2 stepUv = uTexelSize * blurScale;

          for (int dy = -1; dy <= 1; dy++) {
            for (int dx = -1; dx <= 1; dx++) {
              vec2 blurUv = vUv + vec2(float(dx), float(dy)) * stepUv;
              float w = 1.0;
              if (dx == 0 && dy == 0) w = 2.0;
              float v = safeAlpha(texture2D(uTreeMask, blurUv - distortion));
              accum += v * w;
              weightSum += w;
            }
          }

          float blurred = (weightSum > 0.0) ? accum / weightSum : baseShadow;
          float strength = clamp(blurred * uShadowOpacity, 0.0, 1.0);
          float shadowFactor = 1.0 - strength;
          
          // Scale coverage by hover fade so that when the tree graphic fades
          // out on hover, the self-coverage mask drops to 0 and the full
          // unmasked shadow is revealed underneath.
          float coverage = a * uHoverFade;
          gl_FragColor = vec4(shadowFactor, coverage, 0.0, 1.0);
        }
      `,
      transparent: false
    });

    this.shadowMesh = new THREE.Mesh(this.baseMesh.geometry, this.shadowMaterial);
    this.shadowMesh.position.copy(this.baseMesh.position);
    this.shadowMesh.rotation.copy(this.baseMesh.rotation);
    this.shadowMesh.scale.copy(this.baseMesh.scale);

    this.shadowScene.add(this.shadowMesh);
  }

  initialize(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    const THREE = window.THREE;
    if (THREE) {
      this.shadowScene = new THREE.Scene();
      if (this.baseMesh && this.treeMask) {
        this._createShadowMesh();
      }
    }
    log.info('TreeEffect initialized');
  }

  /**
   * Detect whether a texture has a meaningful alpha channel by sampling pixels.
   * Returns true if the texture lacks real alpha (all pixels are opaque),
   * meaning we need to derive alpha from color content in the shader.
   * @param {THREE.Texture} texture
   * @returns {boolean} True if alpha should be derived from color
   * @private
   */
  _needsDerivedAlpha(texture) {
    try {
      const img = texture?.image;
      if (!img) return false;

      const sampleSize = 64;
      const canvas = document.createElement('canvas');
      canvas.width = sampleSize;
      canvas.height = sampleSize;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, sampleSize, sampleSize);
      const data = ctx.getImageData(0, 0, sampleSize, sampleSize).data;

      for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 250) return false;
      }

      log.info('Tree texture has no alpha channel \u2014 will derive alpha from color content');
      return true;
    } catch (e) {
      log.debug('Alpha detection failed, assuming texture has alpha:', e);
      return false;
    }
  }

  setBaseMesh(baseMesh, assetBundle) {
    if (!assetBundle || !assetBundle.masks) return;
    this.baseMesh = baseMesh;

    const treeData = assetBundle.masks.find(m => m.id === 'tree' || m.type === 'tree');
    const nextMask = treeData?.texture || null;
    const maskChanged = this.treeMask !== nextMask;
    this.treeMask = nextMask;

    // Detect whether the texture needs derived alpha (no real alpha channel)
    this._deriveAlpha = this.treeMask ? this._needsDerivedAlpha(this.treeMask) : false;

    // Scene switches can keep the effect instance around briefly; ensure we don't
    // carry motion/hover state across fundamentally different scenes.
    this._resetTemporalState();

    // CPU-side alpha mask is derived from the GPU texture image; invalidate if the
    // underlying texture changed.
    if (maskChanged) {
      this._clearAlphaMaskCache();
    }

    if (!this.treeMask) {
      this.enabled = false;
      return;
    }
    if (this.scene) this._createMesh();
    if (this.shadowScene && this.treeMask) this._createShadowMesh();
  }

  /**
   * Subscribe to the EffectMaskRegistry for 'tree' mask updates.
   * @param {import('../assets/EffectMaskRegistry.js').EffectMaskRegistry} registry
   */
  connectToRegistry(registry) {
    if (this._registryUnsub) { this._registryUnsub(); this._registryUnsub = null; }
    this._registryUnsub = registry.subscribe('tree', (texture) => {
      const maskChanged = this.treeMask !== texture;
      this.treeMask = texture;
      this._deriveAlpha = texture ? this._needsDerivedAlpha(texture) : false;
      this._resetTemporalState();
      if (maskChanged) this._clearAlphaMaskCache();
      if (!texture) { this.enabled = false; return; }
      this.enabled = true;
      if (this.scene) this._createMesh();
      if (this.shadowScene) this._createShadowMesh();
    });
  }

  // ── TileBindableEffect interface ────────────────────────────────────────────

  /**
   * TileBindableEffect: load the per-tile _Tree mask texture.
   * Called by TileEffectBindingManager before bindTileSprite().
   * @param {object} tileDoc
   * @returns {Promise<THREE.Texture|null>}
   */
  async loadTileMask(tileDoc) {
    const tileManager = window.MapShine?.tileManager;
    if (!tileManager) return null;
    try {
      return await tileManager.loadTileTreeMaskTexture(tileDoc) || null;
    } catch (_) {
      return null;
    }
  }

  /**
   * TileBindableEffect: skip tiles with no texture (can't derive mask path).
   * @param {object} tileDoc
   * @returns {boolean}
   */
  shouldBindTile(tileDoc) {
    return !!(tileDoc?.texture?.src || tileDoc?.id);
  }

  /**
   * TileBindableEffect: bind a per-tile tree overlay mesh.
   * Creates a PlaneGeometry mesh at the tile's world transform using the same
   * wind shader as the scene-wide mesh. Skips if no mask texture is provided.
   * @param {object} tileDoc
   * @param {THREE.Object3D} sprite
   * @param {THREE.Texture|null} treeMaskTexture
   */
  bindTileSprite(tileDoc, sprite, treeMaskTexture) {
    const tileId = tileDoc?.id;
    const THREE = window.THREE;
    if (!tileId || !THREE || !this.scene || !sprite || !treeMaskTexture) return;

    // Roof tiles never get tree overlays.
    if (sprite?.userData?.isWeatherRoof) {
      this.unbindTileSprite(tileId);
      return;
    }

    // Rebind if already exists.
    this.unbindTileSprite(tileId);

    const deriveAlpha = this._needsDerivedAlpha(treeMaskTexture);
    const mat = this._createTileOverlayMaterial(treeMaskTexture, deriveAlpha);

    const geom = new THREE.PlaneGeometry(1, 1, 1, 1);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.matrixAutoUpdate = false;

    // Trees render above overhead tiles (same as scene-wide mesh renderOrder + 20).
    const baseOrder = (typeof sprite.renderOrder === 'number') ? sprite.renderOrder : 0;
    mesh.renderOrder = baseOrder + 20;

    // Enable roof layer so LightingEffect includes this in tRoofAlpha.
    mesh.layers.enable(20);

    this._syncTileMeshToSprite(mesh, sprite);
    mesh.visible = !!(this._enabled && sprite.visible);

    this.scene.add(mesh);
    this._tileOverlays.set(tileId, { mesh, material: mat, sprite });
  }

  /**
   * TileBindableEffect: remove and dispose a per-tile tree overlay.
   * @param {string} tileId
   */
  unbindTileSprite(tileId) {
    const data = this._tileOverlays.get(tileId);
    if (!data) return;
    try { if (data.mesh && this.scene) this.scene.remove(data.mesh); } catch (_) {}
    try { data.mesh?.geometry?.dispose?.(); } catch (_) {}
    try { data.material?.dispose?.(); } catch (_) {}
    this._tileOverlays.delete(tileId);
  }

  /**
   * TileBindableEffect: keep the per-tile overlay aligned with its sprite.
   * @param {string} tileId
   * @param {THREE.Object3D} sprite
   */
  syncTileSpriteTransform(tileId, sprite) {
    const data = this._tileOverlays.get(tileId);
    if (!data?.mesh || !sprite) return;
    if (sprite?.userData?.isWeatherRoof) { this.unbindTileSprite(tileId); return; }
    data.sprite = sprite;
    this._syncTileMeshToSprite(data.mesh, sprite);
    const baseOrder = (typeof sprite.renderOrder === 'number') ? sprite.renderOrder : 0;
    data.mesh.renderOrder = baseOrder + 20;
  }

  /**
   * TileBindableEffect: sync overlay visibility with the owning tile.
   * @param {string} tileId
   * @param {THREE.Object3D} sprite
   */
  syncTileSpriteVisibility(tileId, sprite) {
    const data = this._tileOverlays.get(tileId);
    if (!data?.mesh) return;
    data.mesh.visible = !!(this._enabled && sprite?.visible);
  }

  /**
   * Copy a sprite's world transform onto a per-tile overlay mesh.
   * Reads position, scale, and material.rotation (animated tiles).
   * @param {THREE.Mesh} mesh
   * @param {THREE.Object3D} sprite
   * @private
   */
  _syncTileMeshToSprite(mesh, sprite) {
    const THREE = window.THREE;
    if (!THREE) return;
    mesh.position.copy(sprite.position);
    mesh.scale.copy(sprite.scale);
    // Animated rotation lives on sprite.material.rotation (radians).
    const rot = Number(sprite?.material?.rotation) || 0;
    mesh.rotation.set(0, 0, rot);
    mesh.updateMatrix();
  }

  /**
   * Create a ShaderMaterial for a per-tile tree overlay.
   * Reuses the same vertex/fragment shader as the scene-wide mesh.
   * @param {THREE.Texture} treeMask
   * @param {boolean} deriveAlpha
   * @returns {THREE.ShaderMaterial}
   * @private
   */
  _createTileOverlayMaterial(treeMask, deriveAlpha) {
    const THREE = window.THREE;
    // Build a material identical to _createMesh() but bound to the per-tile mask.
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTreeMask: { value: treeMask },
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
        uHoverFade: { value: 1.0 },
        uDeriveAlpha: { value: deriveAlpha ? 1.0 : 0.0 }
      },
      vertexShader: this.material?.vertexShader || this._getTileVertexShader(),
      fragmentShader: this.material?.fragmentShader || this._getTileFragmentShader(),
      transparent: true,
      depthWrite: false,
      depthTest: true
    });
    // Tag so update() can sync uniforms to all tile overlay materials.
    mat._isTileOverlay = true;
    if (!this._tileOverlayMaterials) this._tileOverlayMaterials = new Set();
    this._tileOverlayMaterials.add(mat);
    return mat;
  }

  _getTileVertexShader() {
    return `
      varying vec2 vUv;
      varying vec2 vWorldPos;
      void main() {
        vUv = uv;
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPos = worldPos.xy;
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `;
  }

  _getTileFragmentShader() {
    // Identical to the scene-wide fragment shader but with uDeriveAlpha uniform
    // so we can handle both alpha-channel and color-derived alpha textures.
    return `
      uniform sampler2D uTreeMask;
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
      uniform float uHoverFade;
      uniform float uDeriveAlpha;
      varying vec2 vUv;
      varying vec2 vWorldPos;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
      float noise(vec2 p) {
        vec2 i=floor(p); vec2 f=fract(p); vec2 u=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y);
      }
      float msLuminance(vec3 c) { return dot(c,vec3(0.2126,0.7152,0.0722)); }
      vec3 applyCC(vec3 color) {
        color *= pow(2.0,uExposure);
        color.r+=uTemperature*0.1; color.b-=uTemperature*0.1; color.g+=uTint*0.1;
        color+=vec3(uBrightness);
        color=(color-0.5)*uContrast+0.5;
        float l=msLuminance(color); color=mix(vec3(l),color,uSaturation);
        return color;
      }
      float safeAlpha(vec4 s) {
        float a=s.a;
        if(uDeriveAlpha>0.5 && a>0.99) {
          float lum=dot(s.rgb,vec3(0.2126,0.7152,0.0722));
          float maxC=max(s.r,max(s.g,s.b)); float minC=min(s.r,min(s.g,s.b));
          float chroma=maxC-minC;
          float bgMask=smoothstep(0.45,0.85,lum)*(1.0-smoothstep(0.0,0.15,chroma));
          a*=(1.0-bgMask);
        }
        return a;
      }
      void main() {
        vec2 windDir=normalize(uWindDir);
        if(length(windDir)<0.01) windDir=vec2(1,0);
        float speed=uWindSpeed*uWindSpeedGlobal;
        float effectiveSpeed=0.1+speed;
        vec2 gustPos=vWorldPos*uGustFrequency;
        vec2 scroll=windDir*uTime*uGustSpeed*effectiveSpeed;
        float gustNoise=noise(gustPos-scroll);
        float gustStrength=smoothstep(0.2,0.8,gustNoise);
        vec2 perpDir=vec2(-windDir.y,windDir.x);
        float orbitPhase=uTime*uElasticity+(gustNoise*5.0);
        float orbitSway=sin(orbitPhase);
        float pushMagnitude=gustStrength*uBranchBend*effectiveSpeed;
        float swayMagnitude=orbitSway*(uBranchBend*0.4)*effectiveSpeed*(0.5+0.5*gustStrength);
        float noiseVal=noise(vWorldPos*uFlutterScale);
        float flutterPhase=uTime*uFlutterSpeed*effectiveSpeed+noiseVal*6.28;
        float flutter=sin(flutterPhase);
        float flutterMagnitude=flutter*uFlutterIntensity*(0.5+0.5*gustStrength);
        vec2 distortion=(windDir*pushMagnitude)+(perpDir*swayMagnitude)+vec2(flutter,flutter)*flutterMagnitude;
        vec4 treeSample=texture2D(uTreeMask,vUv-distortion);
        if(treeSample.a>0.01 && treeSample.a<0.99) {
          treeSample.rgb=clamp((treeSample.rgb-(1.0-treeSample.a))/treeSample.a,0.0,1.0);
        }
        float a=safeAlpha(treeSample)*uIntensity*uHoverFade;
        if(a<=0.001) discard;
        vec3 color=applyCC(treeSample.rgb);
        gl_FragColor=vec4(color,clamp(a,0.0,1.0));
      }
    `;
  }

  _createMesh() {
    const THREE = window.THREE;
    if (!THREE || !this.baseMesh || !this.treeMask) return;

    if (this.mesh && this.scene) {
      this.scene.remove(this.mesh);
      this.mesh = null;
    }
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTreeMask: { value: this.treeMask },
        uTime: { value: 0.0 },
        uWindDir: { value: new THREE.Vector2(1.0, 0.0) },
        uWindSpeed: { value: 0.0 },
        
        // Params
        uIntensity: { value: (this.params.intensity ?? 1.0) },
        uWindSpeedGlobal: { value: this.params.windSpeedGlobal },
        uGustFrequency: { value: this.params.gustFrequency },
        uGustSpeed: { value: this.params.gustSpeed },
        uBranchBend: { value: this.params.branchBend },
        uElasticity: { value: this.params.elasticity },
        uFlutterIntensity: { value: this.params.flutterIntensity },
        uFlutterSpeed: { value: this.params.flutterSpeed },
        uFlutterScale: { value: this.params.flutterScale },
        
        // Color
        uExposure: { value: this.params.exposure },
        uBrightness: { value: this.params.brightness },
        uContrast: { value: this.params.contrast },
        uSaturation: { value: this.params.saturation },
        uTemperature: { value: this.params.temperature },
        uTint: { value: this.params.tint },

        uHoverFade: { value: 1.0 }
        // Note: No shadow reception uniforms (Tree is top-most)
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec2 vWorldPos; 

        void main() {
          vUv = uv;
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldPos = worldPos.xy; 
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: `
        uniform sampler2D uTreeMask;
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

        uniform float uHoverFade;

        varying vec2 vUv;
        varying vec2 vWorldPos;

        // Pseudo-random hash
        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }

        // Gradient Noise
        float noise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(mix(hash(i + vec2(0.0,0.0)), hash(i + vec2(1.0,0.0)), u.x),
                       mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), u.x), u.y);
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

        // Extract effective alpha, handling textures without a real alpha channel.
        // When the raw alpha is fully opaque AND the pixel is bright + desaturated
        // (white/gray background), return 0 so the pixel is treated as transparent.
        float safeAlpha(vec4 s) {
          float a = s.a;
          if (a > 0.99) {
            float lum    = dot(s.rgb, vec3(0.2126, 0.7152, 0.0722));
            float maxC   = max(s.r, max(s.g, s.b));
            float minC   = min(s.r, min(s.g, s.b));
            float chroma = maxC - minC;
            // Catch anti-aliased edges (tree color blended with white bg)
            // by using a wide luminance range and generous chroma tolerance.
            float bgMask = smoothstep(0.45, 0.85, lum)
                         * (1.0 - smoothstep(0.0, 0.15, chroma));
            a *= (1.0 - bgMask);
          }
          return a;
        }

        void main() {
          // 1. Calculate Environmental Factors
          vec2 windDir = normalize(uWindDir);
          if (length(windDir) < 0.01) windDir = vec2(1.0, 0.0);
          
          float speed = uWindSpeed * uWindSpeedGlobal;
          float ambientMotion = 0.1; 
          float effectiveSpeed = ambientMotion + speed;

          // 2. Compute "Gust" Field (Main Push)
          vec2 gustPos = vWorldPos * uGustFrequency;
          vec2 scroll = windDir * uTime * uGustSpeed * effectiveSpeed;
          
          float gustNoise = noise(gustPos - scroll);
          float gustStrength = smoothstep(0.2, 0.8, gustNoise);

          // 3. Compute "Orbit" (Perpendicular Sway)
          vec2 perpDir = vec2(-windDir.y, windDir.x);
          
          float orbitPhase = uTime * uElasticity + (gustNoise * 5.0);
          float orbitSway = sin(orbitPhase);

          // 4. Combine Forces
          float pushMagnitude = gustStrength * uBranchBend * effectiveSpeed;
          float swayMagnitude = orbitSway * (uBranchBend * 0.4) * effectiveSpeed * (0.5 + 0.5 * gustStrength);

          // 5. Leaf Flutter
          float noiseVal = noise(vWorldPos * uFlutterScale);
          float flutterPhase = uTime * uFlutterSpeed * effectiveSpeed + noiseVal * 6.28;
          float flutter = sin(flutterPhase);
          float flutterMagnitude = flutter * uFlutterIntensity * (0.5 + 0.5 * gustStrength);

          vec2 distortion = (windDir * pushMagnitude) 
                          + (perpDir * swayMagnitude) 
                          + vec2(flutter, flutter) * flutterMagnitude;

          // Sample Texture
          vec4 treeSample = texture2D(uTreeMask, vUv - distortion);

          // Fix white fringe from bilinear filtering of straight-alpha textures.
          // The GPU interpolates between opaque tree pixels and transparent pixels
          // whose RGB is white, producing semi-transparent pixels with white-
          // contaminated color.  Undo the contamination (assuming bg = white).
          if (treeSample.a > 0.01 && treeSample.a < 0.99) {
            treeSample.rgb = clamp(
              (treeSample.rgb - (1.0 - treeSample.a)) / treeSample.a,
              0.0, 1.0
            );
          }

          // Smart alpha: also detect and discard opaque white/gray background
          // pixels (catches textures saved without proper transparency).
          float a = safeAlpha(treeSample) * uIntensity * uHoverFade;
          if (a <= 0.001) discard;

          vec3 color = treeSample.rgb;
          color = applyCC(color);

          // No shadow reception - Trees are top canopy
          
          gl_FragColor = vec4(color, clamp(a, 0.0, 1.0));
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true
    });

    this.mesh = new THREE.Mesh(this.baseMesh.geometry, this.material);
    this.mesh.position.copy(this.baseMesh.position);
    // Keep trees just above the ground plane.
    // Ground Z is now canonical (see SceneComposer.createBasePlane), so a hardcoded
    // small-Z value can put the mesh behind the map.
    this.mesh.position.z = (this.baseMesh.position?.z ?? 0) + 0.5;
    
    this.mesh.rotation.copy(this.baseMesh.rotation);
    this.mesh.scale.copy(this.baseMesh.scale);
    this.mesh.renderOrder = (this.baseMesh.renderOrder || 0) + 20; // Ensure draw on top
    
    // ENABLE ROOF LAYER (20)
    // This ensures LightingEffect renders this into tRoofAlpha, which:
    // 1. Prevents ground shadows from darkening the tree (mix(shadow, 1.0, roofAlpha))
    // 2. Prevents ground lights from lighting the tree (sunlight only)
    this.mesh.layers.enable(20);

    this.scene.add(this.mesh);
    this.mesh.visible = this._enabled;
  }

  update(timeInfo) {
    if (!this.material || !this.mesh || !this._enabled) return;

    const u = this.material.uniforms;
    u.uTime.value = timeInfo.elapsed;
    
    const now = timeInfo.elapsed;
    const delta = now - (this._lastFrameTime || now);
    this._lastFrameTime = now;
    const safeDelta = Math.min(delta, 0.1); 

    const mapShine = window.MapShine || window.mapShine;

    // --- Weather Integration ---
    try {
      const state = weatherController?.getCurrentState?.();
      if (state) {
        if (state.windDirection) {
          u.uWindDir.value.set(state.windDirection.x, state.windDirection.y);
          if (this.shadowMaterial && this.shadowMaterial.uniforms && this.shadowMaterial.uniforms.uWindDir) {
            this.shadowMaterial.uniforms.uWindDir.value.set(state.windDirection.x, state.windDirection.y);
          }
        }
        
        const targetWindSpeed = (typeof state.windSpeed === 'number') ? state.windSpeed : 0.0;
        
        const smoothingFactor = this.params.windRampSpeed * safeDelta;
        const alpha = Math.max(0.0, Math.min(1.0, smoothingFactor));
        
        this._currentWindSpeed += (targetWindSpeed - this._currentWindSpeed) * alpha;

        u.uWindSpeed.value = this._currentWindSpeed;
        if (this.shadowMaterial && this.shadowMaterial.uniforms && this.shadowMaterial.uniforms.uWindSpeed) {
          this.shadowMaterial.uniforms.uWindSpeed.value = this._currentWindSpeed;
        }
      }
    } catch (e) {
      u.uWindSpeed.value = 0.0;
      if (this.shadowMaterial && this.shadowMaterial.uniforms && this.shadowMaterial.uniforms.uWindSpeed) {
        this.shadowMaterial.uniforms.uWindSpeed.value = 0.0;
      }
    }

    // --- Parameter Sync ---
    u.uIntensity.value = (this.params.intensity ?? 1.0);
    u.uWindSpeedGlobal.value = this.params.windSpeedGlobal;
    u.uGustFrequency.value = this.params.gustFrequency;
    u.uGustSpeed.value = this.params.gustSpeed;
    u.uBranchBend.value = this.params.branchBend;
    u.uElasticity.value = this.params.elasticity;
    u.uFlutterIntensity.value = this.params.flutterIntensity;
    u.uFlutterSpeed.value = this.params.flutterSpeed;
    u.uFlutterScale.value = this.params.flutterScale;

    u.uExposure.value = this.params.exposure;
    u.uBrightness.value = this.params.brightness;
    u.uContrast.value = this.params.contrast;
    u.uSaturation.value = this.params.saturation;
    u.uTemperature.value = this.params.temperature;
    u.uTint.value = this.params.tint;

    const dt = timeInfo.delta ?? safeDelta;
    const targetFade = this._hoverHidden ? 0.0 : 1.0;
    const currentFade = this._hoverFade;
    const diffFade = targetFade - currentFade;
    const absDiffFade = Math.abs(diffFade);

    if (absDiffFade > 0.0005) {
      const maxStep = dt / 2;
      const step = Math.sign(diffFade) * Math.min(absDiffFade, maxStep);
      this._hoverFade = currentFade + step;
    } else {
      this._hoverFade = targetFade;
    }

    u.uHoverFade.value = this._hoverFade;

    // Sync all per-tile overlay materials with the same wind/time/params as the scene-wide mesh.
    if (this._tileOverlayMaterials && this._tileOverlayMaterials.size > 0) {
      for (const mat of this._tileOverlayMaterials) {
        if (!mat?.uniforms) continue;
        const tu = mat.uniforms;
        if (tu.uTime) tu.uTime.value = timeInfo.elapsed;
        if (tu.uWindDir) tu.uWindDir.value.copy(u.uWindDir.value);
        if (tu.uWindSpeed) tu.uWindSpeed.value = this._currentWindSpeed;
        if (tu.uIntensity) tu.uIntensity.value = (this.params.intensity ?? 1.0);
        if (tu.uWindSpeedGlobal) tu.uWindSpeedGlobal.value = this.params.windSpeedGlobal;
        if (tu.uGustFrequency) tu.uGustFrequency.value = this.params.gustFrequency;
        if (tu.uGustSpeed) tu.uGustSpeed.value = this.params.gustSpeed;
        if (tu.uBranchBend) tu.uBranchBend.value = this.params.branchBend;
        if (tu.uElasticity) tu.uElasticity.value = this.params.elasticity;
        if (tu.uFlutterIntensity) tu.uFlutterIntensity.value = this.params.flutterIntensity;
        if (tu.uFlutterSpeed) tu.uFlutterSpeed.value = this.params.flutterSpeed;
        if (tu.uFlutterScale) tu.uFlutterScale.value = this.params.flutterScale;
        if (tu.uExposure) tu.uExposure.value = this.params.exposure;
        if (tu.uBrightness) tu.uBrightness.value = this.params.brightness;
        if (tu.uContrast) tu.uContrast.value = this.params.contrast;
        if (tu.uSaturation) tu.uSaturation.value = this.params.saturation;
        if (tu.uTemperature) tu.uTemperature.value = this.params.temperature;
        if (tu.uTint) tu.uTint.value = this.params.tint;
        if (tu.uHoverFade) tu.uHoverFade.value = this._hoverFade;
      }
    }

    if (this.shadowMaterial && this.shadowMaterial.uniforms) {
      const su = this.shadowMaterial.uniforms;
      su.uTime.value = timeInfo.elapsed;
      su.uWindSpeedGlobal.value = this.params.windSpeedGlobal;
      su.uGustFrequency.value = this.params.gustFrequency;
      su.uGustSpeed.value = this.params.gustSpeed;
      su.uBranchBend.value = this.params.branchBend;
      su.uElasticity.value = this.params.elasticity;
      su.uFlutterIntensity.value = this.params.flutterIntensity;
      su.uFlutterSpeed.value = this.params.flutterSpeed;
      su.uFlutterScale.value = this.params.flutterScale;

      su.uShadowOpacity.value = 1.0;
      su.uHoverFade.value = this._hoverFade;

      su.uShadowLength.value = this.params.shadowLength;
      su.uShadowSoftness.value = this.params.shadowSoftness;
      
      // Screen Space Shadows Setup
      const THREE = window.THREE;
      if (THREE && this.renderer) {
        // PERFORMANCE: Reuse Vector2 instead of allocating every frame
        if (!this._tempSize) this._tempSize = new THREE.Vector2();
        const size = this._tempSize;
        this.renderer.getDrawingBufferSize(size);
        if (su.uResolution) su.uResolution.value.set(size.x, size.y);
        if (su.uTexelSize) su.uTexelSize.value.set(1 / size.x, 1 / size.y);
      }
      
      // Sync sun direction
      try {
        const overhead = mapShine?.overheadShadowsEffect;
        if (su.uSunDir) {
          if (overhead && overhead.sunDir) {
            su.uSunDir.value.copy(overhead.sunDir);
          } else if (weatherController) {
            // Fallback time-of-day
            let hour = 12.0;
            try { if (typeof weatherController.timeOfDay === 'number') hour = weatherController.timeOfDay; } catch (e) {}
            const t = (hour % 24.0) / 24.0;
            const azimuth = (t - 0.5) * Math.PI;
            // Read sun latitude from the global Environment source of truth
            const globalLat = window.MapShine?.uiManager?.globalParams?.sunLatitude;
            const lat = (typeof globalLat === 'number') ? globalLat
              : (overhead && overhead.params) ? (overhead.params.sunLatitude ?? 0.5) : 0.5;
            su.uSunDir.value.set(-Math.sin(azimuth), Math.cos(azimuth) * lat);
          }
        }
        if (su.uZoom) {
          // Prefer sceneComposer.currentZoom (FOV-based zoom system)
          const sceneComposer = window.MapShine?.sceneComposer;
          if (sceneComposer?.currentZoom !== undefined) {
            su.uZoom.value = sceneComposer.currentZoom;
          } else if (this.camera?.isOrthographicCamera) {
            su.uZoom.value = this.camera.zoom;
          } else if (this.camera) {
            const dist = this.camera.position.z;
            su.uZoom.value = (dist > 0.1) ? (10000.0 / dist) : 1.0;
          }
        }
      } catch (e) {}
    }
  }

  render(renderer, scene, camera) {
    if (!this.enabled || !this.shadowMaterial || !this.shadowScene) return;

    const THREE = window.THREE;
    if (!THREE) return;

    // PERFORMANCE: Reuse Vector2 instead of allocating every frame
    if (!this._tempSize) this._tempSize = new THREE.Vector2();
    const size = this._tempSize;
    renderer.getDrawingBufferSize(size);

    if (!this.shadowTarget) {
      this.shadowTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else if (this.shadowTarget.width !== size.x || this.shadowTarget.height !== size.y) {
      this.shadowTarget.setSize(size.x, size.y);
    }

    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.shadowTarget);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.render(this.shadowScene, this.camera);
    renderer.setRenderTarget(previousTarget);
  }
}
