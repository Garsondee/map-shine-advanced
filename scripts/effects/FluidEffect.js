import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';

const log = createLogger('FluidEffect');

export class FluidEffect extends EffectBase {
  constructor() {
    super('fluid', RenderLayers.SURFACE_EFFECTS, 'low');

    this.priority = 12;
    this.alwaysRender = false;

    this._enabled = true;

    /** @type {THREE.Scene|null} */
    this._scene = null;

    /** @type {Map<string, {mesh: THREE.Mesh, material: THREE.ShaderMaterial, sprite: THREE.Sprite, maskTexture: THREE.Texture}>} */
    this._tileOverlays = new Map();

    /** @type {Set<THREE.ShaderMaterial>} */
    this._materials = new Set();

    /** @type {THREE.Texture|null} */
    this._roofAlphaMap = null;

    /** @type {{x:number,y:number}|null} */
    this._screenSize = null;

    this.params = {
      intensity: 1.0,
      opacity: 0.7,

      maskThresholdLo: 0.05,
      maskThresholdHi: 0.2,

      // Hex strings for Tweakpane color picker compatibility
      colorA: '#26a6ff',
      colorB: '#a60dff',
      ageGamma: 1.0,

      // 0 = ping-pong (oscillates back and forth), 1 = directional (constant travel young→old)
      flowMode: 1.0,
      flowSpeed: 0.35,
      pulseFrequency: 3.0,
      pulseStrength: 0.7,
      slugWidth: 0.4,
      edgeSoftness: 0.02,

      noiseScale: 6.0,
      noiseStrength: 0.25,
      bubbleScale: 18.0,
      bubbleStrength: 0.12,

      // Roof handling
      roofOcclusionEnabled: true,
      roofAlphaThreshold: 0.1
    };
  }

  /**
   * Get Tweakpane UI control schema.
   * @returns {Object}
   * @public
   */
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'appearance',
          label: 'Appearance',
          type: 'inline',
          parameters: ['intensity', 'opacity', 'colorA', 'colorB', 'ageGamma']
        },
        {
          name: 'masking',
          label: 'Mask Thresholds',
          type: 'folder',
          expanded: false,
          parameters: ['maskThresholdLo', 'maskThresholdHi']
        },
        {
          name: 'motion',
          label: 'Flow & Motion',
          type: 'folder',
          expanded: false,
          parameters: ['flowMode', 'flowSpeed', 'pulseFrequency', 'pulseStrength', 'slugWidth', 'edgeSoftness']
        },
        {
          name: 'detail',
          label: 'Detail & Bubbles',
          type: 'folder',
          expanded: false,
          parameters: ['noiseScale', 'noiseStrength', 'bubbleScale', 'bubbleStrength']
        },
        {
          name: 'roof',
          label: 'Roof Occlusion',
          type: 'folder',
          expanded: false,
          parameters: ['roofOcclusionEnabled', 'roofAlphaThreshold']
        }
      ],
      parameters: {
        intensity:          { type: 'slider', label: 'Intensity',          min: 0,   max: 3,    step: 0.01, default: 1.0 },
        opacity:            { type: 'slider', label: 'Opacity',            min: 0,   max: 1,    step: 0.01, default: 0.7 },
        colorA:             { type: 'color',  label: 'Color A (Young)',    default: '#26a6ff' },
        colorB:             { type: 'color',  label: 'Color B (Old)',      default: '#a60dff' },
        ageGamma:           { type: 'slider', label: 'Age Gamma',          min: 0.1, max: 4,    step: 0.01, default: 1.0 },

        maskThresholdLo:    { type: 'slider', label: 'Low Threshold',      min: 0,   max: 0.5,  step: 0.001, default: 0.05 },
        maskThresholdHi:    { type: 'slider', label: 'High Threshold',     min: 0,   max: 1,    step: 0.01,  default: 0.2 },

        flowMode:           { type: 'slider', label: 'Flow Mode (0=Ping-Pong, 1=Directional)', min: 0, max: 1, step: 1, default: 1.0 },
        flowSpeed:          { type: 'slider', label: 'Flow Speed',         min: 0,   max: 2,    step: 0.01, default: 0.35 },
        pulseFrequency:     { type: 'slider', label: 'Slug Count',         min: 0.5, max: 20,   step: 0.1,  default: 3.0 },
        pulseStrength:      { type: 'slider', label: 'Gap Transparency',   min: 0,   max: 1,    step: 0.01, default: 0.7 },
        slugWidth:          { type: 'slider', label: 'Slug Width',         min: 0.05, max: 0.95, step: 0.01, default: 0.4 },
        edgeSoftness:       { type: 'slider', label: 'Edge Softness',      min: 0.005, max: 0.2, step: 0.005, default: 0.02 },

        noiseScale:         { type: 'slider', label: 'Noise Scale',        min: 0.5, max: 30,   step: 0.1,  default: 6.0 },
        noiseStrength:      { type: 'slider', label: 'Noise Strength',     min: 0,   max: 1,    step: 0.01, default: 0.25 },
        bubbleScale:        { type: 'slider', label: 'Bubble Scale',       min: 1,   max: 60,   step: 0.5,  default: 18.0 },
        bubbleStrength:     { type: 'slider', label: 'Bubble Strength',    min: 0,   max: 0.5,  step: 0.01, default: 0.12 },

        roofOcclusionEnabled: { type: 'boolean', label: 'Enable Roof Occlusion', default: true },
        roofAlphaThreshold:   { type: 'slider',  label: 'Roof Alpha Threshold',  min: 0, max: 1, step: 0.01, default: 0.1 }
      },
      presets: {
        'Default (Lab Pipes)': {
          intensity: 1.0, opacity: 0.7,
          colorA: '#26a6ff', colorB: '#a60dff', ageGamma: 1.0,
          flowMode: 1.0, flowSpeed: 0.35, pulseFrequency: 3.0, pulseStrength: 0.7,
          slugWidth: 0.4, edgeSoftness: 0.02,
          noiseScale: 6.0, noiseStrength: 0.25, bubbleScale: 18.0, bubbleStrength: 0.12
        },
        'Toxic Sludge': {
          intensity: 1.2, opacity: 0.85,
          colorA: '#33ff22', colorB: '#889900', ageGamma: 0.6,
          flowMode: 1.0, flowSpeed: 0.15, pulseFrequency: 2.0, pulseStrength: 0.5,
          slugWidth: 0.5, edgeSoftness: 0.04,
          noiseScale: 4.0, noiseStrength: 0.4, bubbleScale: 12.0, bubbleStrength: 0.3
        },
        'Lava': {
          intensity: 1.5, opacity: 0.9,
          colorA: '#ff4400', colorB: '#ffcc00', ageGamma: 1.5,
          flowMode: 1.0, flowSpeed: 0.08, pulseFrequency: 1.5, pulseStrength: 0.5,
          slugWidth: 0.6, edgeSoftness: 0.08,
          noiseScale: 3.0, noiseStrength: 0.5, bubbleScale: 8.0, bubbleStrength: 0.2
        },
        'Blood': {
          intensity: 0.8, opacity: 0.75,
          colorA: '#880000', colorB: '#440011', ageGamma: 0.8,
          flowMode: 0.0, flowSpeed: 0.12, pulseFrequency: 2.0, pulseStrength: 0.4,
          slugWidth: 0.35, edgeSoftness: 0.03,
          noiseScale: 5.0, noiseStrength: 0.2, bubbleScale: 20.0, bubbleStrength: 0.08
        }
      }
    };
  }

  get enabled() {
    return this._enabled;
  }

  set enabled(v) {
    this._enabled = !!v;
    const overlays = this._tileOverlays;
    if (!overlays || typeof overlays.values !== 'function') return;
    for (const data of overlays.values()) {
      if (data?.mesh) data.mesh.visible = this._enabled;
    }
  }

  initialize(renderer, scene, camera) {
    this._scene = scene;
  }

  /**
   * Bind a per-tile fluid overlay.
   * @param {object} tileDoc
   * @param {THREE.Sprite} sprite
   * @param {THREE.Texture} fluidMaskTexture
   */
  bindTileSprite(tileDoc, sprite, fluidMaskTexture) {
    const tileId = tileDoc?.id;
    const THREE = window.THREE;
    if (!tileId || !THREE || !this._scene || !sprite || !fluidMaskTexture) return;

    // If roof tile, never bind.
    if (sprite?.userData?.isWeatherRoof) {
      this.unbindTileSprite(tileId);
      return;
    }

    // Rebind if already exists.
    this.unbindTileSprite(tileId);

    const material = this._createMaterial(fluidMaskTexture);
    this._materials.add(material);

    const geom = new THREE.PlaneGeometry(1, 1, 1, 1);
    const mesh = new THREE.Mesh(geom, material);
    mesh.matrixAutoUpdate = false;

    // Render under the tile. For bypass tiles renderOrder=1000; we still want under.
    const baseOrder = (typeof sprite.renderOrder === 'number') ? sprite.renderOrder : 0;
    mesh.renderOrder = baseOrder - 1;

    this._syncMeshToSprite(mesh, sprite);

    // Initial visibility
    mesh.visible = !!(this._enabled && sprite.visible);

    this._scene.add(mesh);

    this._tileOverlays.set(tileId, { mesh, material, sprite, maskTexture: fluidMaskTexture });
  }

  /**
   * Unbind/remove a per-tile overlay.
   * @param {string} tileId
   */
  unbindTileSprite(tileId) {
    const data = this._tileOverlays.get(tileId);
    if (!data) return;

    try {
      if (data.mesh && this._scene) this._scene.remove(data.mesh);
    } catch (_) {
    }

    try {
      data.mesh?.geometry?.dispose?.();
    } catch (_) {
    }

    try {
      if (data.material) {
        this._materials.delete(data.material);
        data.material.dispose?.();
      }
    } catch (_) {
    }

    this._tileOverlays.delete(tileId);
  }

  /**
   * Keep an existing overlay glued to its sprite.
   * @param {string} tileId
   * @param {THREE.Sprite} sprite
   */
  syncTileSpriteTransform(tileId, sprite) {
    const data = this._tileOverlays.get(tileId);
    if (!data?.mesh || !sprite) return;

    // If tile became a roof tile, remove overlay.
    if (sprite?.userData?.isWeatherRoof) {
      this.unbindTileSprite(tileId);
      return;
    }

    data.sprite = sprite;
    this._syncMeshToSprite(data.mesh, sprite);

    // Keep renderOrder under tile.
    const baseOrder = (typeof sprite.renderOrder === 'number') ? sprite.renderOrder : 0;
    data.mesh.renderOrder = baseOrder - 1;
  }

  /**
   * Keep visibility in sync with the owning tile.
   * @param {string} tileId
   * @param {THREE.Sprite} sprite
   */
  syncTileSpriteVisibility(tileId, sprite) {
    const data = this._tileOverlays.get(tileId);
    if (!data?.mesh) return;

    const vis = !!(this._enabled && sprite?.visible);
    data.mesh.visible = vis;
  }

  setRoofAlphaMap(tex) {
    this._roofAlphaMap = tex || null;
    for (const mat of this._materials) {
      if (mat?.uniforms?.uRoofAlphaMap) {
        mat.uniforms.uRoofAlphaMap.value = this._roofAlphaMap;
        mat.uniforms.uHasRoofAlphaMap.value = this._roofAlphaMap ? 1.0 : 0.0;
      }
    }
  }

  update(timeInfo) {
    const THREE = window.THREE;
    if (!THREE) return;

    // Opportunistically pull roof alpha from LightingEffect.
    try {
      const le = window.MapShine?.lightingEffect;
      const next = le?.roofAlphaTarget?.texture || le?.roofAlphaTarget || null;
      if (next && next !== this._roofAlphaMap) {
        this.setRoofAlphaMap(next);
      }

      // Screen size for roof alpha sampling.
      const w = le?.roofAlphaTarget?.width;
      const h = le?.roofAlphaTarget?.height;
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        if (!this._screenSize) this._screenSize = { x: w, y: h };
        else {
          this._screenSize.x = w;
          this._screenSize.y = h;
        }
      }
    } catch (_) {
    }

    if (!this._screenSize) {
      this._screenSize = { x: window.innerWidth || 1, y: window.innerHeight || 1 };
    }

    for (const data of this._tileOverlays.values()) {
      const m = data?.material;
      const u = m?.uniforms;
      if (!u) continue;

      u.uTime.value = timeInfo.elapsed;
      u.uIntensity.value = this.params.intensity;
      u.uOpacity.value = this.params.opacity;

      u.uMaskThresholdLo.value = this.params.maskThresholdLo;
      u.uMaskThresholdHi.value = this.params.maskThresholdHi;

      // Colors are stored as hex strings for Tweakpane; convert to THREE.Color.
      try { u.uColorA.value.set(this.params.colorA); } catch (_) {}
      try { u.uColorB.value.set(this.params.colorB); } catch (_) {}
      u.uAgeGamma.value = this.params.ageGamma;

      u.uFlowMode.value = this.params.flowMode;
      u.uFlowSpeed.value = this.params.flowSpeed;
      u.uPulseFrequency.value = this.params.pulseFrequency;
      u.uPulseStrength.value = this.params.pulseStrength;
      u.uSlugWidth.value = this.params.slugWidth;
      u.uEdgeSoftness.value = this.params.edgeSoftness;

      u.uNoiseScale.value = this.params.noiseScale;
      u.uNoiseStrength.value = this.params.noiseStrength;
      u.uBubbleScale.value = this.params.bubbleScale;
      u.uBubbleStrength.value = this.params.bubbleStrength;

      u.uRoofOcclusionEnabled.value = this.params.roofOcclusionEnabled ? 1.0 : 0.0;
      u.uRoofAlphaThreshold.value = this.params.roofAlphaThreshold;

      if (u.uScreenSize) {
        u.uScreenSize.value.set(this._screenSize.x, this._screenSize.y);
      }
    }
  }

  dispose() {
    for (const tileId of Array.from(this._tileOverlays.keys())) {
      this.unbindTileSprite(tileId);
    }
    this._materials.clear();
    this._scene = null;
  }

  /**
   * Sync overlay mesh transform, visibility, opacity, layers, and renderOrder
   * to the owning tile sprite. Mirrors SpecularEffect._syncTileOverlayTransform.
   */
  _syncMeshToSprite(mesh, sprite) {
    try {
      // Ensure sprite world matrix is current before copying.
      sprite.updateMatrixWorld?.(true);
    } catch (_) {
    }
    try {
      mesh.matrix.copy(sprite.matrixWorld);
      mesh.matrixWorldNeedsUpdate = true;
    } catch (_) {
    }

    // Mirror visibility — respect opacity-based hover-hide (sprite.visible stays
    // true but opacity drops to 0 during hover-hide on overhead tiles).
    let spriteOpacity = 1.0;
    try {
      const o = sprite?.material?.opacity;
      if (typeof o === 'number' && Number.isFinite(o)) spriteOpacity = o;
    } catch (_) {
    }
    mesh.visible = !!(this._enabled && sprite.visible && spriteOpacity > 0.01);

    // Keep renderOrder just under the tile sprite.
    try {
      mesh.renderOrder = (typeof sprite.renderOrder === 'number') ? (sprite.renderOrder - 1) : mesh.renderOrder;
    } catch (_) {
    }

    // Keep layer mask in sync so the overlay renders in the same passes.
    try {
      mesh.layers.mask = sprite.layers.mask;
    } catch (_) {
    }
  }

  _createMaterial(fluidMaskTexture) {
    const THREE = window.THREE;

    // Data mask texture should be sampled without mipmaps.
    try {
      fluidMaskTexture.flipY = true;
      fluidMaskTexture.needsUpdate = true;
    } catch (_) {
    }

    const material = new THREE.ShaderMaterial({
      uniforms: {
        tFluidMask: { value: fluidMaskTexture },

        uTime: { value: 0.0 },

        uIntensity: { value: this.params.intensity },
        uOpacity: { value: this.params.opacity },

        uMaskThresholdLo: { value: this.params.maskThresholdLo },
        uMaskThresholdHi: { value: this.params.maskThresholdHi },

        uColorA: { value: new THREE.Color(this.params.colorA) },
        uColorB: { value: new THREE.Color(this.params.colorB) },

        // Texel size for UV-space finite differences (world-stable gradient).
        uTexelSize: { value: new THREE.Vector2(1.0 / Math.max(1, fluidMaskTexture.image?.width || 512), 1.0 / Math.max(1, fluidMaskTexture.image?.height || 512)) },
        uAgeGamma: { value: this.params.ageGamma },

        uFlowMode: { value: this.params.flowMode },
        uFlowSpeed: { value: this.params.flowSpeed },
        uPulseFrequency: { value: this.params.pulseFrequency },
        uPulseStrength: { value: this.params.pulseStrength },
        uSlugWidth: { value: this.params.slugWidth },
        uEdgeSoftness: { value: this.params.edgeSoftness },

        uNoiseScale: { value: this.params.noiseScale },
        uNoiseStrength: { value: this.params.noiseStrength },
        uBubbleScale: { value: this.params.bubbleScale },
        uBubbleStrength: { value: this.params.bubbleStrength },

        // Roof alpha occlusion (screen space)
        uRoofAlphaMap: { value: this._roofAlphaMap },
        uHasRoofAlphaMap: { value: this._roofAlphaMap ? 1.0 : 0.0 },
        uRoofOcclusionEnabled: { value: this.params.roofOcclusionEnabled ? 1.0 : 0.0 },
        uRoofAlphaThreshold: { value: this.params.roofAlphaThreshold },
        uScreenSize: { value: new THREE.Vector2(window.innerWidth || 1, window.innerHeight || 1) }
      },
      vertexShader: `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
      `.trim(),
      fragmentShader: `
uniform sampler2D tFluidMask;
uniform float uTime;

uniform float uIntensity;
uniform float uOpacity;

uniform float uMaskThresholdLo;
uniform float uMaskThresholdHi;

uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uAgeGamma;

uniform float uFlowMode;
uniform float uFlowSpeed;
uniform float uPulseFrequency;
uniform float uPulseStrength;
uniform float uSlugWidth;
uniform float uEdgeSoftness;

uniform float uNoiseScale;
uniform float uNoiseStrength;
uniform float uBubbleScale;
uniform float uBubbleStrength;

uniform vec2 uTexelSize;

uniform sampler2D uRoofAlphaMap;
uniform float uHasRoofAlphaMap;
uniform float uRoofOcclusionEnabled;
uniform float uRoofAlphaThreshold;
uniform vec2 uScreenSize;

varying vec2 vUv;

// --- Noise utilities ---

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * noise2(p);
    p *= 2.01;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec4 m = texture2D(tFluidMask, vUv);

  // Coverage from alpha * luminance
  float luma = dot(m.rgb, vec3(0.299, 0.587, 0.114));
  float coverage = m.a * luma;
  float mask = smoothstep(uMaskThresholdLo, uMaskThresholdHi, coverage);
  if (mask <= 0.001) discard;

  // ---- Age: white(1,1,1) = young(0), red(1,0,0) = old(1) ----
  // Red channel is always ~1.0 in both white and red pixels.
  // True age is encoded in the DECAY of green + blue channels.
  float age = clamp(1.0 - (m.g + m.b) * 0.5, 0.0, 1.0);
  float ageShaped = pow(age, max(0.001, uAgeGamma));

  // ---- Flow direction from corrected age gradient (finite differences) ----
  // Sample 3 pixels away for a sturdier gradient on high-res textures
  vec2 offset = uTexelSize * 3.0;
  vec4 mR = texture2D(tFluidMask, vUv + vec2(offset.x, 0.0));
  vec4 mL = texture2D(tFluidMask, vUv - vec2(offset.x, 0.0));
  vec4 mU = texture2D(tFluidMask, vUv + vec2(0.0, offset.y));
  vec4 mD = texture2D(tFluidMask, vUv - vec2(0.0, offset.y));

  float ageR = 1.0 - (mR.g + mR.b) * 0.5;
  float ageL = 1.0 - (mL.g + mL.b) * 0.5;
  float ageU = 1.0 - (mU.g + mU.b) * 0.5;
  float ageD = 1.0 - (mD.g + mD.b) * 0.5;

  // No * 0.5 — keep full magnitude so gradient isn't crushed on large textures
  vec2 grad = vec2(ageR - ageL, ageU - ageD);
  float glen = length(grad);
  vec2 flowDir = (glen > 1e-6) ? (grad / glen) : vec2(1.0, 0.0);
  vec2 perp = vec2(-flowDir.y, flowDir.x);
  // isFlowing gates noise/bubble DIRECTION only — not the slug pattern itself
  float isFlowing = smoothstep(0.00001, 0.001, glen);

  // ---- Flow animation ----
  float t = uTime * uFlowSpeed;
  float flowOffset;
  if (uFlowMode < 0.5) {
    // Ping-pong: triangle wave oscillation (0->1->0->1...)
    flowOffset = abs(fract(t * 0.5) * 2.0 - 1.0);
  } else {
    // Directional: constant travel from young end to old end, wrapping
    flowOffset = t;
  }

  // ---- Slug pattern: distinct liquid chunks with transparent gaps ----
  float slugCount = max(1.0, uPulseFrequency);
  float softness = max(0.005, uEdgeSoftness);
  float slugW = clamp(uSlugWidth, 0.05, 0.95);

  // Phase within each slug cell [0, 1) — scrolls with flowOffset
  float slugPhase = fract(age * slugCount - flowOffset);

  // Noise displacement for organic slug edges.
  // Amplitude scales with slug width so narrow slugs can't invert.
  float noiseAmp = min(0.15, slugW * 0.35);
  vec2 noiseBase = vUv * uNoiseScale + flowDir * t * 0.3;
  float noiseLead  = (fbm(noiseBase) - 0.5) * noiseAmp;
  float noiseTrail = (fbm(noiseBase + vec2(17.3, 31.7)) - 0.5) * noiseAmp;

  // Leading edge (slug enters) and trailing edge (slug exits)
  float leadBound = noiseLead;
  float trailBound = slugW + noiseTrail;
  float slugMask = smoothstep(leadBound, leadBound + softness, slugPhase)
                 * (1.0 - smoothstep(trailBound - softness, trailBound, slugPhase));

  // uPulseStrength controls gap transparency (1 = fully transparent gaps, 0 = no gaps)
  float slugAlpha = mix(1.0, slugMask, uPulseStrength);

  // ---- Noise: organic internal variation inside the liquid ----
  vec2 nCoord = vUv * uNoiseScale + flowDir * t * 0.4;
  float n = fbm(nCoord);
  float noiseEffect = mix(1.0, 0.75 + n * 0.5, uNoiseStrength * isFlowing);

  // ---- Bubbles: Voronoi cells (only visible inside liquid slugs) ----
  vec2 bubCoord = vUv * uBubbleScale + flowDir * t * 1.2;
  vec2 cellId = floor(bubCoord);
  vec2 cellFrac = fract(bubCoord);
  float minDist = 1.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 neighbor = vec2(float(dx), float(dy));
      vec2 pt = hash22(cellId + neighbor);
      // Gently animate bubble positions for a living feel
      pt = 0.5 + 0.35 * sin(uTime * 0.6 + 6.2831 * pt);
      float d = length(cellFrac - neighbor - pt);
      minDist = min(minDist, d);
    }
  }
  float bubbles = (1.0 - smoothstep(0.06, 0.12, minDist)) * uBubbleStrength * isFlowing * slugMask;

  // ---- Color compositing ----
  vec3 baseColor = mix(uColorA, uColorB, ageShaped);
  vec3 col = baseColor * noiseEffect;

  // Specular glint traveling along pipe (only inside liquid)
  float glintPhase = age * slugCount * 1.5 - flowOffset * 1.5 + n * 2.0;
  float glint = pow(max(0.0, sin(glintPhase) * 0.5 + 0.5), 8.0) * 0.3 * isFlowing * slugMask;
  col += vec3(glint);

  // Bubble highlights (additive white)
  col += vec3(bubbles);

  // ---- Roof alpha occlusion (screen-space) ----
  if (uRoofOcclusionEnabled > 0.5 && uHasRoofAlphaMap > 0.5) {
    vec2 suv = gl_FragCoord.xy / max(vec2(1.0), uScreenSize);
    float roofA = texture2D(uRoofAlphaMap, suv).a;
    if (roofA > uRoofAlphaThreshold) {
      discard;
    }
  }

  // Slug alpha cuts real transparent gaps between liquid chunks
  float alpha = clamp(uOpacity * mask * uIntensity * slugAlpha, 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
}
      `.trim(),
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending
    });

    return material;
  }
}
