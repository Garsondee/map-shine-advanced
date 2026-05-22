/**
 * @fileoverview BloomEffectV2 — V2 screen-space bloom post-processing pass.
 *
 * Wraps THREE.UnrealBloomPass to produce high-quality multi-mip bloom glow.
 * Pipeline: threshold bright pixels → progressive mip-chain blur → additive composite.
 *
 * Simplifications vs V1:
 *   - No vision masking via FoundryFogBridge (deferred)
 *   - No scene-rect padding exclusion (V2 compositor handles this)
 *   - No ember hotspot layer injection (deferred)
 *   - No V1 readBuffer/writeBuffer pattern — uses inputRT/outputRT directly
 *
 * Features retained:
 *   - Strength, radius, threshold controls
 *   - Bloom tint color (warm/cool glow)
 *   - Blend opacity
 *
 * Outdoor spill suppress: after UnrealBloomPass, dark outdoor pixels (_Outdoors)
 * lose convolved bloom unless the pre-bloom HDR scene is already bright there —
 * stops indoor window glow halos on surrounding ground without killing legitimate
 * outdoor highlights (sun, torches, water specular).
 *
 * @module compositor-v2/effects/BloomEffectV2
 */

import { createLogger } from '../../core/log.js';
import {
  GLSL_DECODE_OUTDOORS_MASK,
  GLSL_SCREEN_TO_SCENE_UV,
  applySceneViewProjectionToUniforms,
  createSceneViewProjectionCache,
  updateSceneViewProjectionFromCamera,
} from '../scene-view-projection.js';

const log = createLogger('BloomEffectV2');

export class BloomEffectV2 {
  constructor() {
    /** @type {boolean} */
    this._initialized = false;

    this.params = {
      enabled: true,
      strength: 0.4,
      radius: 1,
      threshold: 2,
      tintColor: { r: 1, g: 1, b: 1 },
      blendOpacity: 1.0,
      // WaterEffectV2 writes a linear specular mask; injected here before UnrealBloom threshold.
      waterSpecularBloomEnabled: true,
      waterSpecularBloomStrength: 8,
      waterSpecularBloomGamma: 0.81,
      // During landscape/map-point lightning the scene gets a broad HDR lift; bloom
      // can turn that into visible bands — adapt threshold/strength while strikes play.
      lightningBloomAdaptEnabled: true,
      lightningBloomThresholdBoost: 2.0,
      lightningBloomStrengthMul: 0.3,
      lightningBloomRadiusMul: 0.55,
      lightningBloomSmoothWidth: 0.45,
      lightningBloomBlendMul: 0.65,
      lightningBloomPassthroughPeak: 0.88,
      lightningBloomMapPointWeight: 0.15,
      // Outdoor spill: blur from indoor window glow lands on dark outdoor ground —
      // suppress bloom there unless the base HDR scene is already bright locally.
      outdoorSpillSuppressEnabled: true,
      outdoorSpillLumLoMul: 0.42,
      outdoorSpillLumHiMul: 0.92,
    };

    /** @type {number} Effective pass strength after lightning adaptation. */
    this._effectiveStrength = 0.4;
    /** @type {number} Effective pass threshold after lightning adaptation. */
    this._effectiveThreshold = 2;
    /** @type {number} Effective pass radius after lightning adaptation. */
    this._effectiveRadius = 1;
    /** @type {number} Effective blend opacity after lightning adaptation. */
    this._effectiveBlendOpacity = 1;
    /** @type {boolean} Skip bloom entirely during the brightest strike peak. */
    this._lightningPassthrough = false;

    // ── GPU resources ───────────────────────────────────────────────────
    /** @type {THREE.UnrealBloomPass|null} */
    this._pass = null;

    /**
     * Internal RT used as the "readBuffer" for UnrealBloomPass.
     * We copy inputRT → this RT, run the pass (which writes back into it),
     * then copy the result → outputRT.
     * @type {THREE.WebGLRenderTarget|null}
     */
    this._bloomInputRT = null;

    // Copy/blit resources for RT-to-RT transfers
    /** @type {THREE.Scene|null} */
    this._copyScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._copyCamera = null;
    /** @type {THREE.MeshBasicMaterial|null} */
    this._copyMaterial = null;
    /** @type {THREE.Mesh|null} */
    this._copyQuad = null;

    /** @type {THREE.Vector3|null} */
    this._tintVec = null;
    this._lastTintR = null;
    this._lastTintG = null;
    this._lastTintB = null;

    /** @type {THREE.Texture|null} Second target from WaterEffectV2 MRT (linear RGB mask). */
    this._waterSpecBloomTexture = null;

    /** @type {THREE.Scene|null} */
    this._waterBloomCompositeScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._waterBloomCompositeCamera = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._waterBloomCompositeMaterial = null;
    /** @type {THREE.DataTexture|null} */
    this._black1x1Texture = null;

    /** @type {THREE.Texture|null} Active-floor / stacked `_Outdoors` for spill suppression. */
    this._outdoorsMask = null;

    /** @type {THREE.WebGLRenderTarget|null} Scene HDR snapshot before UnrealBloomPass. */
    this._preBloomSceneRT = null;

    /** @type {import('../scene-view-projection.js').SceneViewProjectionCache} */
    this._viewProjectionCache = createSceneViewProjectionCache();
    this._projTmpNdc = null;
    this._projTmpWorld = null;
    this._projTmpDir = null;

    this._spillSuppressScene = null;
    this._spillSuppressCamera = null;
    this._spillSuppressMaterial = null;
  }

  // ── UI schema (moved from V1 BloomEffect) ────────────────────────────────

  static getControlSchema() {
    const white = { r: 1, g: 1, b: 1 };
    const warm = { r: 1, g: 0.96, b: 0.88 };
    const neon = { r: 0.75, g: 0.92, b: 1 };

    return {
      enabled: true,
      help: {
        title: 'Bloom (glow)',
        summary: [
          'Adds screen-space glow around bright pixels (highlights, lamps, sky, specular) using a multi-pass blur.',
          'No tile masks required. Runs after the main scene is composited (post-processing).',
          'Water specular can feed a dedicated linear mask (see Water → Bloom link) so sun glints bloom strongly without over-brightening the base image.',
          'During lightning strikes bloom can adapt automatically (Lightning strike folder) to avoid banded halos from broad HDR flash lifts.',
          'Performance: extra full-screen passes and mip blur — lower radius and blend on large maps or weak GPUs if needed.',
          'Persistence: these controls save with the scene (not World Based).',
        ].join('\n\n'),
        glossary: {
          Strength: 'How much glow is added on top of the image.',
          Radius: 'Spread of the glow (blur footprint). Higher = wider halos.',
          Threshold: 'Brightness cutoff (linear). Only pixels above this contribute to bloom.',
          'Glow tint': 'Multiplies bloom color per mip (warm candlelight vs cool moonlight).',
          'Blend opacity': 'Master mix for the entire bloom composite (0 = off).',
          'Water bloom (specular)': 'Adds linear HDR from water specular/highlight mask before threshold — strong glints without crushing the beauty pass.',
          'Water bloom strength': 'How much of the water mask is added into the bloom input (linear).',
          'Water bloom gamma': 'Curve on the injected mask (<1 = punchier peaks, >1 = softer).',
          'Lightning adapt': 'While distant or map-point lightning is active, bloom raises its cutoff and softens the knee so broad HDR flashes do not turn into banded halos.',
          'Lightning threshold boost': 'Extra linear cutoff added during strikes (keeps the flash wash out of bloom).',
          'Lightning strength mul': 'Bloom strength multiplier at full strike intensity (0 = off).',
          'Lightning radius mul': 'Bloom radius multiplier at full strike intensity.',
          'Lightning smooth width': 'Wider high-pass knee during strikes — reduces banding at the cutoff edge.',
          'Lightning blend mul': 'Overall bloom mix multiplier at full strike intensity.',
          'Lightning passthrough peak': 'Above this strike weight, bloom is skipped for one frame path (flash already reads as glow).',
          'Lightning map-point weight': 'How much localized arc flashes contribute to adaptation (lower keeps arc bloom).',
          'Outdoor spill suppress': 'Stops window-light bloom halos from washing onto dark outdoor ground around buildings (_Outdoors mask).',
          'Outdoor spill lum lo': 'Outdoor pixels darker than threshold × this keep no spill bloom.',
          'Outdoor spill lum hi': 'Full outdoor bloom returns when base HDR exceeds threshold × this.',
        },
      },
      groups: [
        {
          name: 'look',
          label: 'Look',
          type: 'folder',
          expanded: true,
          parameters: ['strength', 'radius', 'threshold'],
        },
        {
          name: 'water-spec-bloom',
          label: 'Water specular (bloom)',
          type: 'folder',
          expanded: false,
          parameters: ['waterSpecularBloomEnabled', 'waterSpecularBloomStrength', 'waterSpecularBloomGamma'],
        },
        {
          name: 'grade',
          label: 'Grade',
          type: 'folder',
          expanded: true,
          parameters: ['tintColor', 'blendOpacity'],
        },
        {
          name: 'lightning-strike',
          label: 'Lightning strike',
          type: 'folder',
          expanded: false,
          parameters: [
            'lightningBloomAdaptEnabled',
            'lightningBloomThresholdBoost',
            'lightningBloomStrengthMul',
            'lightningBloomRadiusMul',
            'lightningBloomSmoothWidth',
            'lightningBloomBlendMul',
            'lightningBloomPassthroughPeak',
            'lightningBloomMapPointWeight',
          ],
        },
        {
          name: 'outdoor-spill',
          label: 'Outdoor spill (window glow)',
          type: 'folder',
          expanded: false,
          parameters: [
            'outdoorSpillSuppressEnabled',
            'outdoorSpillLumLoMul',
            'outdoorSpillLumHiMul',
          ],
        },
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },
        strength: {
          type: 'slider',
          label: 'Strength',
          min: 0,
          max: 3,
          step: 0.01,
          default: 0.4,
          tooltip: 'Intensity of the glow added on top of the scene.',
        },
        radius: {
          type: 'slider',
          label: 'Radius',
          min: 0,
          max: 1,
          step: 0.01,
          default: 1,
          tooltip: 'How far the glow spreads (blur size).',
        },
        threshold: {
          type: 'slider',
          label: 'Threshold',
          min: 0,
          max: 4,
          step: 0.01,
          default: 2,
          tooltip: 'Linear brightness floor; only brighter pixels bloom. With the Linear HDR pipeline the merged scene can exceed 1.0, so this range was extended — 1.0 means "only true highlights bloom".',
        },
        tintColor: {
          type: 'color',
          colorType: 'float',
          label: 'Glow tint',
          default: { r: 1, g: 1, b: 1 },
          tooltip: 'Tint applied to bloom (white = neutral).',
        },
        blendOpacity: {
          type: 'slider',
          label: 'Blend opacity',
          min: 0,
          max: 1,
          step: 0.01,
          default: 1.0,
          tooltip: 'Overall bloom mix. Use 0 to disable without turning the effect off.',
        },
        waterSpecularBloomEnabled: {
          type: 'boolean',
          default: true,
          label: 'Link water specular',
          tooltip: 'When on (and water renders a mask), add water specular energy into the bloom input before threshold.',
        },
        waterSpecularBloomStrength: {
          type: 'slider',
          label: 'Water bloom strength',
          min: 0,
          max: 8,
          step: 0.01,
          default: 8,
          tooltip: 'Linear HDR added from the water specular mask. Push high for aggressive sun glints.',
        },
        waterSpecularBloomGamma: {
          type: 'slider',
          label: 'Water bloom gamma',
          min: 0.35,
          max: 3,
          step: 0.01,
          default: 0.81,
          tooltip: 'Shapes the injected mask before bloom (1 = linear). Lower emphasizes peaks.',
        },
        lightningBloomAdaptEnabled: {
          type: 'boolean',
          default: true,
          label: 'Adapt during strikes',
          tooltip: 'Raise bloom cutoff and soften the high-pass knee while lightning flashes are active to avoid banded halos.',
        },
        lightningBloomThresholdBoost: {
          type: 'slider',
          label: 'Strike threshold boost',
          min: 0,
          max: 4,
          step: 0.05,
          default: 2.0,
          tooltip: 'Added to the linear threshold at full strike intensity — keeps broad flash wash out of bloom.',
        },
        lightningBloomStrengthMul: {
          type: 'slider',
          label: 'Strike strength mul',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.3,
          tooltip: 'Bloom strength multiplier when a strike is at peak (flash already adds glow).',
        },
        lightningBloomRadiusMul: {
          type: 'slider',
          label: 'Strike radius mul',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.55,
          tooltip: 'Bloom spread multiplier at full strike intensity — tighter blur reduces banding.',
        },
        lightningBloomSmoothWidth: {
          type: 'slider',
          label: 'Strike smooth width',
          min: 0.05,
          max: 1.5,
          step: 0.01,
          default: 0.45,
          tooltip: 'High-pass knee width during strikes (wider = softer cutoff, fewer bands).',
        },
        lightningBloomBlendMul: {
          type: 'slider',
          label: 'Strike blend mul',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.65,
          tooltip: 'Blend opacity multiplier at full strike intensity.',
        },
        lightningBloomPassthroughPeak: {
          type: 'slider',
          label: 'Passthrough peak',
          min: 0.5,
          max: 1,
          step: 0.01,
          default: 0.88,
          tooltip: 'Skip bloom entirely above this strike weight — useful for the brightest flash peak.',
        },
        lightningBloomMapPointWeight: {
          type: 'slider',
          label: 'Map-point adapt weight',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.15,
          tooltip: 'How much localized arc flashes affect adaptation (lower preserves arc bloom).',
        },
        outdoorSpillSuppressEnabled: {
          type: 'boolean',
          default: true,
          label: 'Suppress outdoor spill',
          tooltip: 'Remove bloom on dark outdoor pixels (_Outdoors) so indoor window glow does not halo onto surrounding ground.',
        },
        outdoorSpillLumLoMul: {
          type: 'slider',
          label: 'Spill lum lo (× threshold)',
          min: 0.05,
          max: 1.5,
          step: 0.01,
          default: 0.42,
          tooltip: 'Outdoor pixels below threshold × this lose spilled bloom entirely.',
        },
        outdoorSpillLumHiMul: {
          type: 'slider',
          label: 'Spill lum hi (× threshold)',
          min: 0.1,
          max: 2.0,
          step: 0.01,
          default: 0.92,
          tooltip: 'Outdoor pixels above threshold × this keep full bloom (sun, torches, water glints).',
        },
      },
      presets: {
        'Clear Noon': {
          strength: 0.55,
          radius: 0.35,
          threshold: 1.15,
          tintColor: { ...white },
          blendOpacity: 1.0,
        },
        'Golden Hour': {
          strength: 0.75,
          radius: 0.55,
          threshold: 1.0,
          tintColor: { ...warm },
          blendOpacity: 1.0,
        },
        'Overcast Day': {
          strength: 0.35,
          radius: 0.55,
          threshold: 1.25,
          tintColor: { r: 0.92, g: 0.96, b: 1.0 },
          blendOpacity: 0.85,
        },
        Storm: {
          strength: 0.25,
          radius: 0.7,
          threshold: 1.45,
          tintColor: { r: 0.85, g: 0.92, b: 1.0 },
          blendOpacity: 0.8,
        },
        'Moonlit Night': {
          strength: 0.5,
          radius: 0.4,
          threshold: 0.95,
          tintColor: { r: 0.75, g: 0.86, b: 1.0 },
          blendOpacity: 0.9,
        },
        'Interior Night': {
          strength: 0.65,
          radius: 0.35,
          threshold: 0.9,
          tintColor: { r: 1.0, g: 0.88, b: 0.68 },
          blendOpacity: 1.0,
        },
        Subtle: {
          strength: 0.45,
          radius: 0.2,
          threshold: 1.15,
          tintColor: { ...white },
          blendOpacity: 1.0,
        },
        Strong: {
          strength: 0.9,
          radius: 0.75,
          threshold: 0.95,
          tintColor: { ...white },
          blendOpacity: 1.0,
        },
        Dreamy: {
          strength: 1.1,
          radius: 1.0,
          threshold: 0.85,
          tintColor: { ...warm },
          blendOpacity: 1.0,
        },
        Neon: {
          strength: 1.8,
          radius: 0.3,
          threshold: 0.55,
          tintColor: { ...neon },
          blendOpacity: 1.0,
        },
      },
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * @param {number} w - Render target width
   * @param {number} h - Render target height
   */
  initialize(w, h) {
    const THREE = window.THREE;
    if (!THREE || !THREE.UnrealBloomPass) {
      log.warn('THREE.UnrealBloomPass not available — bloom disabled');
      return;
    }

    const size = new THREE.Vector2(w, h);

    // Create the UnrealBloomPass with default params
    this._pass = new THREE.UnrealBloomPass(
      size,
      this.params.strength,
      this.params.radius,
      this.params.threshold
    );

    // Internal RT for the pass to read from and write back to.
    // LinearSRGBColorSpace: bloom operates in linear space so the threshold
    // and additive composite are physically correct.
    this._bloomInputRT = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this._bloomInputRT.texture.colorSpace = THREE.LinearSRGBColorSpace;

    this._preBloomSceneRT = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this._preBloomSceneRT.texture.colorSpace = THREE.LinearSRGBColorSpace;

    this._projTmpNdc = new THREE.Vector3();
    this._projTmpWorld = new THREE.Vector3();
    this._projTmpDir = new THREE.Vector3();

    this._buildSpillSuppressPass();

    // Copy scene for RT-to-RT blits
    this._copyScene = new THREE.Scene();
    this._copyCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._copyMaterial = new THREE.MeshBasicMaterial({ map: null });
    this._copyMaterial.toneMapped = false;
    this._copyQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this._copyMaterial
    );
    this._copyQuad.frustumCulled = false;
    this._copyScene.add(this._copyQuad);

    const blackPx = new Uint8Array([0, 0, 0, 255]);
    this._black1x1Texture = new THREE.DataTexture(blackPx, 1, 1, THREE.RGBAFormat);
    this._black1x1Texture.needsUpdate = true;

    this._waterBloomCompositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tWaterSpecBloom: { value: this._black1x1Texture },
        uWaterBloomMix: { value: 0 },
        uWaterBloomGamma: { value: 1.0 },
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
        uniform sampler2D tWaterSpecBloom;
        uniform float uWaterBloomMix;
        uniform float uWaterBloomGamma;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          vec3 h0 = texture2D(tWaterSpecBloom, vUv).rgb * uWaterBloomMix;
          float g = max(0.05, uWaterBloomGamma);
          vec3 h = pow(max(h0, vec3(0.0)), vec3(g));
          gl_FragColor = vec4(c.rgb + h, c.a);
        }
      `,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const wbQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this._waterBloomCompositeMaterial
    );
    wbQuad.frustumCulled = false;
    this._waterBloomCompositeScene = new THREE.Scene();
    this._waterBloomCompositeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._waterBloomCompositeScene.add(wbQuad);

    this._tintVec = new THREE.Vector3(1, 1, 1);
    this._updateTintColor();

    this._initialized = true;
    log.info(`BloomEffectV2 initialized (${w}x${h})`);
  }

  // ── Per-frame update ──────────────────────────────────────────────────

  /**
   * Bind `_Outdoors` for outdoor bloom spill suppression (white = outdoor).
   * @param {THREE.Texture|null} texture
   */
  setOutdoorsMask(texture) {
    this._outdoorsMask = texture ?? null;
    const u = this._spillSuppressMaterial?.uniforms;
    if (!u) return;
    u.uOutdoorsMask.value = texture ?? null;
    u.uHasOutdoorsMask.value = texture ? 1.0 : 0.0;
    u.uOutdoorsMaskFlipY.value = texture?.flipY ? 1.0 : 0.0;
  }

  /**
   * @private
   */
  _buildSpillSuppressPass() {
    const THREE = window.THREE;
    if (!THREE) return;

    this._spillSuppressMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tPreBloom: { value: null },
        tPostBloom: { value: null },
        uOutdoorsMask: { value: null },
        uHasOutdoorsMask: { value: 0.0 },
        uOutdoorsMaskFlipY: { value: 0.0 },
        uSpillEnabled: { value: 1.0 },
        uSpillLumLo: { value: 0.8 },
        uSpillLumHi: { value: 1.8 },
        uViewCorner00: { value: new THREE.Vector2(0, 0) },
        uViewCorner10: { value: new THREE.Vector2(1, 0) },
        uViewCorner01: { value: new THREE.Vector2(0, 1) },
        uViewCorner11: { value: new THREE.Vector2(1, 1) },
        uSceneOrigin: { value: new THREE.Vector2(0, 0) },
        uSceneSize: { value: new THREE.Vector2(1, 1) },
        uSceneDimensions: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tPreBloom;
        uniform sampler2D tPostBloom;
        uniform sampler2D uOutdoorsMask;
        uniform float uHasOutdoorsMask;
        uniform float uOutdoorsMaskFlipY;
        uniform float uSpillEnabled;
        uniform float uSpillLumLo;
        uniform float uSpillLumHi;
        uniform vec2 uViewCorner00;
        uniform vec2 uViewCorner10;
        uniform vec2 uViewCorner01;
        uniform vec2 uViewCorner11;
        uniform vec2 uSceneOrigin;
        uniform vec2 uSceneSize;
        uniform vec2 uSceneDimensions;
        varying vec2 vUv;

        ${GLSL_SCREEN_TO_SCENE_UV}
        ${GLSL_DECODE_OUTDOORS_MASK}

        void main() {
          vec3 pre = texture2D(tPreBloom, vUv).rgb;
          vec3 post = texture2D(tPostBloom, vUv).rgb;
          vec3 bloomOnly = max(post - pre, vec3(0.0));

          if (uSpillEnabled < 0.5 || uHasOutdoorsMask < 0.5) {
            gl_FragColor = vec4(post, 1.0);
            return;
          }

          vec2 sceneUvRaw = msScreenUvToSceneUvRaw(
            vUv, uViewCorner00, uViewCorner10, uViewCorner01, uViewCorner11,
            uSceneOrigin, uSceneSize, uSceneDimensions
          );
          float inScene = msInSceneBounds(sceneUvRaw);
          vec2 maskUv = clamp(sceneUvRaw, 0.0, 1.0);
          if (uOutdoorsMaskFlipY > 0.5) maskUv.y = 1.0 - maskUv.y;
          float outdoor = msDecodeOutdoorsMaskSample(texture2D(uOutdoorsMask, maskUv)) * inScene;

          float preLum = max(pre.r, max(pre.g, pre.b));
          float localBright = smoothstep(uSpillLumLo, max(uSpillLumHi, uSpillLumLo + 1e-4), preLum);
          float spillKeep = mix(1.0, localBright, outdoor);
          vec3 outRgb = pre + bloomOnly * spillKeep;
          gl_FragColor = vec4(outRgb, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._spillSuppressMaterial);
    quad.frustumCulled = false;
    this._spillSuppressScene = new THREE.Scene();
    this._spillSuppressScene.add(quad);
    this._spillSuppressCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  /**
   * @private
   * @param {THREE.Camera|null} camera
   */
  _syncSpillProjectionUniforms(camera) {
    const u = this._spillSuppressMaterial?.uniforms;
    const dims = canvas?.dimensions;
    const cam = camera
      ?? window.MapShine?.sceneComposer?.camera
      ?? null;
    if (!u || !cam || !dims) return;

    const sc = window.MapShine?.sceneComposer;
    const groundZ = sc?.basePlaneMesh?.position?.z ?? (sc?.groundZ ?? 0);
    updateSceneViewProjectionFromCamera(
      cam,
      groundZ,
      this._viewProjectionCache,
      { ndc: this._projTmpNdc, world: this._projTmpWorld, dir: this._projTmpDir },
    );
    applySceneViewProjectionToUniforms(this._viewProjectionCache, u);

    const fd = sc?.foundrySceneData ?? null;
    const sr = dims.sceneRect ?? dims;
    const sceneX = Number(fd?.sceneX ?? sr?.x ?? 0);
    const sceneY = Number(fd?.sceneY ?? sr?.y ?? 0);
    const sceneW = Number(fd?.sceneWidth ?? fd?.width ?? sr?.width ?? dims.width ?? 1);
    const sceneH = Number(fd?.sceneHeight ?? fd?.height ?? sr?.height ?? dims.height ?? 1);
    u.uSceneOrigin.value.set(sceneX, sceneY);
    u.uSceneSize.value.set(sceneW, sceneH);
    u.uSceneDimensions.value.set(
      Number(fd?.width ?? dims.width ?? 1),
      Number(fd?.height ?? dims.height ?? 1),
    );
  }

  /**
   * @private
   */
  _copyRT(renderer, srcTex, destRT) {
    this._copyMaterial.map = srcTex;
    renderer.setRenderTarget(destRT);
    renderer.autoClear = true;
    renderer.render(this._copyScene, this._copyCamera);
  }

  /**
   * Push current params to the UnrealBloomPass.
   * @param {{ elapsed: number, delta: number }} _timeInfo
   */
  update(_timeInfo) {
    if (!this._initialized || !this._pass) return;
    if (!this.params.enabled) return;

    this._applyLightningAdaptationToPass();

    // Update tint color if changed
    const tc = this.params.tintColor;
    if (tc.r !== this._lastTintR || tc.g !== this._lastTintG || tc.b !== this._lastTintB) {
      this._updateTintColor();
    }
  }

  /**
   * Apply the current tint color to all bloom mip levels.
   * @private
   */
  /**
   * @param {THREE.Texture|null} tex - RGB linear mask from WaterEffectV2, or null to disable.
   */
  setWaterSpecularBloomTexture(tex) {
    this._waterSpecBloomTexture = tex || null;
  }

  /**
   * Strike weight from MapShine environment (0..1). Landscape wash drives most
   * of the banding; map-point arcs contribute lightly so localized bloom remains.
   * @returns {number}
   * @private
   */
  _resolveLightningAdaptWeight() {
    if (this.params.lightningBloomAdaptEnabled === false) return 0;
    try {
      const env = window.MapShine?.environment;
      const landscape01 = Math.max(0, Math.min(1, Number(env?.landscapeLightningFlash01) || 0));
      const mapPoint01 = Math.max(0, Math.min(1, Number(env?.lightningFlash01) || 0));
      const mapWeight = Math.max(0, Math.min(1, Number(this.params.lightningBloomMapPointWeight) ?? 0.15));
      return Math.max(landscape01, mapPoint01 * mapWeight);
    } catch (_) {
      return 0;
    }
  }

  /**
   * Derive effective bloom pass params while lightning is active.
   * @param {number} strikeWeight
   * @returns {{
   *   strength: number,
   *   threshold: number,
   *   radius: number,
   *   blendOpacity: number,
   *   smoothWidth: number,
   *   passthrough: boolean,
   * }}
   * @private
   */
  _computeLightningAdaptation(strikeWeight) {
    const p = this.params;
    const w = Math.max(0, Math.min(1, Number(strikeWeight) || 0));
    const baseStrength = Math.max(0, Number(p.strength) || 0);
    const baseThreshold = Math.max(0, Number(p.threshold) || 0);
    const baseRadius = Math.max(0, Number(p.radius) || 0);
    const baseBlend = Math.max(0, Math.min(1, Number(p.blendOpacity) ?? 1));

    if (w <= 1e-4) {
      return {
        strength: baseStrength,
        threshold: baseThreshold,
        radius: baseRadius,
        blendOpacity: baseBlend,
        smoothWidth: 0.01,
        passthrough: false,
      };
    }

    const thresholdBoost = Math.max(0, Number(p.lightningBloomThresholdBoost) ?? 2.0);
    const strengthMul = Math.max(0, Math.min(1, Number(p.lightningBloomStrengthMul) ?? 0.3));
    const radiusMul = Math.max(0, Math.min(1, Number(p.lightningBloomRadiusMul) ?? 0.55));
    const blendMul = Math.max(0, Math.min(1, Number(p.lightningBloomBlendMul) ?? 0.65));
    const smoothPeak = Math.max(0.05, Number(p.lightningBloomSmoothWidth) ?? 0.45);
    const passthroughPeak = Math.max(0.5, Math.min(1, Number(p.lightningBloomPassthroughPeak) ?? 0.88));

    const lerp = (a, b) => a + (b - a) * w;
    const effectiveStrength = baseStrength * lerp(1, strengthMul);
    const effectiveThreshold = baseThreshold + w * thresholdBoost;
    const effectiveRadius = baseRadius * lerp(1, radiusMul);
    const effectiveBlend = baseBlend * lerp(1, blendMul);
    const passthrough = w >= passthroughPeak
      || (effectiveStrength <= 1e-6)
      || (effectiveBlend <= 1e-6);

    return {
      strength: effectiveStrength,
      threshold: effectiveThreshold,
      radius: effectiveRadius,
      blendOpacity: effectiveBlend,
      smoothWidth: lerp(0.01, smoothPeak),
      passthrough,
    };
  }

  /**
   * Push strike-aware params to UnrealBloomPass. Called from update() and render()
   * so bloom reads the same-frame environment (weather lightning publishes after update).
   * @private
   */
  _applyLightningAdaptationToPass() {
    if (!this._pass) return;

    const adapt = this._computeLightningAdaptation(this._resolveLightningAdaptWeight());
    this._lightningPassthrough = adapt.passthrough;
    this._effectiveStrength = adapt.strength;
    this._effectiveThreshold = adapt.threshold;
    this._effectiveRadius = adapt.radius;
    this._effectiveBlendOpacity = adapt.blendOpacity;

    this._pass.strength = this._effectiveStrength;
    this._pass.radius = this._effectiveRadius;
    this._pass.threshold = this._effectiveThreshold;

    try {
      if (this._pass.highPassUniforms?.smoothWidth) {
        this._pass.highPassUniforms.smoothWidth.value = adapt.smoothWidth;
      }
    } catch (_) {}

    try {
      const u = this._pass.copyUniforms || this._pass.blendMaterial?.uniforms;
      if (u?.opacity?.value !== undefined) {
        u.opacity.value = this._effectiveBlendOpacity;
      }
    } catch (_) {}
  }

  _updateTintColor() {
    if (!this._pass || !this._tintVec) return;

    const tc = this.params.tintColor;
    this._tintVec.set(tc.r, tc.g, tc.b);

    const tintColors = this._pass.bloomTintColors;
    if (tintColors) {
      for (let i = 0; i < tintColors.length; i++) {
        tintColors[i].copy(this._tintVec);
      }
    }

    this._lastTintR = tc.r;
    this._lastTintG = tc.g;
    this._lastTintB = tc.b;
  }

  // ── Render ────────────────────────────────────────────────────────────

  /**
   * Copy input → output (used when bloom is disabled or strength is zero).
   * @returns {boolean}
   * @private
   */
  _passthrough(renderer, inputRT, outputRT) {
    if (!this._copyMaterial || !inputRT?.texture || !outputRT) return false;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    try {
      this._copyMaterial.map = inputRT.texture;
      renderer.setRenderTarget(outputRT);
      renderer.autoClear = true;
      renderer.render(this._copyScene, this._copyCamera);
      return true;
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }
  }

  /**
   * Execute the bloom post-processing pass.
   *
   * Flow:
   * 1. Copy inputRT → _bloomInputRT (optional water specular inject)
   * 2. Snapshot pre-bloom HDR → _preBloomSceneRT
   * 3. UnrealBloomPass adds bloom into _bloomInputRT
   * 4. Optional outdoor spill suppress → outputRT
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} inputRT
   * @param {THREE.WebGLRenderTarget} outputRT
   * @param {THREE.Camera|null} [camera=null] - For `_Outdoors` spill UV projection.
   * @returns {boolean} True when outputRT was written (bloom or passthrough).
   */
  render(renderer, inputRT, outputRT, camera = null) {
    if (!this._initialized || !this._pass || !inputRT || !outputRT) return false;

    this._applyLightningAdaptationToPass();

    const p = this.params;
    if (
      !this.params.enabled
      || this._lightningPassthrough
      || !(this._effectiveStrength > 1e-6)
      || !(this._effectiveBlendOpacity > 1e-6)
    ) {
      return this._passthrough(renderer, inputRT, outputRT);
    }

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    try {
      // Step 1: Copy inputRT → _bloomInputRT (optionally add water specular mask in linear)
      const p0 = this.params;
      const useWaterBloom = this._waterSpecBloomTexture
        && p0.waterSpecularBloomEnabled !== false
        && (Number(p0.waterSpecularBloomStrength) > 1e-6);
      if (useWaterBloom && this._waterBloomCompositeMaterial && this._waterBloomCompositeScene) {
        const wm = this._waterBloomCompositeMaterial.uniforms;
        wm.tDiffuse.value = inputRT.texture;
        wm.tWaterSpecBloom.value = this._waterSpecBloomTexture;
        wm.uWaterBloomMix.value = Number(p0.waterSpecularBloomStrength) || 0;
        wm.uWaterBloomGamma.value = Math.max(0.05, Number(p0.waterSpecularBloomGamma) || 1.0);
        renderer.setRenderTarget(this._bloomInputRT);
        renderer.autoClear = true;
        renderer.render(this._waterBloomCompositeScene, this._waterBloomCompositeCamera);
      } else {
        this._copyRT(renderer, inputRT.texture, this._bloomInputRT);
      }

      // Step 2: Pre-bloom snapshot for spill isolation (outdoor window-glow halos).
      this._copyRT(renderer, this._bloomInputRT.texture, this._preBloomSceneRT);

      // Step 3: UnrealBloomPass (reads + writes _bloomInputRT in place).
      this._pass.render(renderer, null, this._bloomInputRT, 0.016, false);

      const useSpillSuppress = p0.outdoorSpillSuppressEnabled !== false
        && this._outdoorsMask
        && this._spillSuppressMaterial
        && this._spillSuppressScene;

      if (useSpillSuppress) {
        const su = this._spillSuppressMaterial.uniforms;
        const effThreshold = Math.max(0, Number(this._effectiveThreshold) || Number(p0.threshold) || 0);
        su.uSpillEnabled.value = 1.0;
        su.uSpillLumLo.value = effThreshold * Math.max(0.01, Number(p0.outdoorSpillLumLoMul) ?? 0.42);
        su.uSpillLumHi.value = effThreshold * Math.max(0.02, Number(p0.outdoorSpillLumHiMul) ?? 0.92);
        su.tPreBloom.value = this._preBloomSceneRT.texture;
        su.tPostBloom.value = this._bloomInputRT.texture;
        this._syncSpillProjectionUniforms(camera);
        renderer.setRenderTarget(outputRT);
        renderer.autoClear = true;
        renderer.render(this._spillSuppressScene, this._spillSuppressCamera);
      } else {
        this._copyRT(renderer, this._bloomInputRT.texture, outputRT);
      }
    } catch (e) {
      // Fallback: pass through input → output on error
      try {
        this._copyMaterial.map = inputRT.texture;
        renderer.setRenderTarget(outputRT);
        renderer.autoClear = true;
        renderer.render(this._copyScene, this._copyCamera);
      } catch (_) {}

      if (Math.random() < 0.01) {
        log.warn('BloomEffectV2 render error:', e);
      }
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }
    return true;
  }

  // ── Resize ────────────────────────────────────────────────────────────

  /**
   * Resize internal render targets and the UnrealBloomPass.
   * @param {number} w
   * @param {number} h
   */
  onResize(w, h) {
    if (this._pass) {
      this._pass.setSize(w, h);
    }
    if (this._bloomInputRT) {
      this._bloomInputRT.setSize(w, h);
    }
    if (this._preBloomSceneRT) {
      this._preBloomSceneRT.setSize(w, h);
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  dispose() {
    try { this._pass?.dispose(); } catch (_) {}
    try { this._bloomInputRT?.dispose(); } catch (_) {}
    try { this._preBloomSceneRT?.dispose(); } catch (_) {}
    try { this._copyMaterial?.dispose(); } catch (_) {}
    try { this._copyQuad?.geometry?.dispose(); } catch (_) {}
    try {
      const q = this._waterBloomCompositeScene?.children?.[0];
      if (q?.geometry) q.geometry.dispose();
    } catch (_) {}
    try {
      const sq = this._spillSuppressScene?.children?.[0];
      if (sq?.geometry) sq.geometry.dispose();
    } catch (_) {}
    try { this._spillSuppressMaterial?.dispose(); } catch (_) {}
    try { this._waterBloomCompositeMaterial?.dispose(); } catch (_) {}
    try { this._black1x1Texture?.dispose(); } catch (_) {}
    this._waterBloomCompositeScene = null;
    this._waterBloomCompositeCamera = null;
    this._waterBloomCompositeMaterial = null;
    this._black1x1Texture = null;
    this._waterSpecBloomTexture = null;
    this._pass = null;
    this._bloomInputRT = null;
    this._preBloomSceneRT = null;
    this._outdoorsMask = null;
    this._spillSuppressScene = null;
    this._spillSuppressCamera = null;
    this._spillSuppressMaterial = null;
    this._copyScene = null;
    this._copyCamera = null;
    this._copyMaterial = null;
    this._copyQuad = null;
    this._tintVec = null;
    this._initialized = false;
    log.info('BloomEffectV2 disposed');
  }
}
