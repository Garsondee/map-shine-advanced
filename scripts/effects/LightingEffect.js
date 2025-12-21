/**
 * @fileoverview Lighting Effect
 * Implements dynamic lighting for the scene base plane.
 * Replaces Foundry's PIXI lighting with a multipass Three.js approach.
 * @module effects/LightingEffect
 */

import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { weatherController } from '../core/WeatherController.js';

import { ThreeLightSource } from './ThreeLightSource.js'; // Import the class above
import { ThreeDarknessSource } from './ThreeDarknessSource.js';
import { OVERLAY_THREE_LAYER } from './EffectComposer.js';

const log = createLogger('LightingEffect');

// TEMPORARY KILL-SWITCH: Disable lighting effect for perf testing.
// Set to true to skip all lighting passes and render scene directly.
// Currently FALSE so normal rendering works while we profile other systems.
const DISABLE_LIGHTING_EFFECT = false;

export class LightingEffect extends EffectBase {
  constructor() {
    super('lighting', RenderLayers.POST_PROCESSING, 'low');
    
    this.priority = 1; 
    
    // UI Parameters matching Foundry VTT + Custom Tweaks
    // NOTE: LightingEffect now ONLY handles lighting math (ambient + dynamic lights).
    // All tone mapping, exposure, contrast, saturation is handled by ColorCorrectionEffect.
    // See docs/CONTRAST-DARKNESS-ANALYSIS.md for rationale.
    this.params = {
      enabled: true,
      globalIllumination: 1.0, // Multiplier for ambient
      lightIntensity: 0.8, // Master multiplier for dynamic lights
      darknessEffect: 0.5, // Scales Foundry's darknessLevel
      darknessLevel: 0.0, // Read-only mostly, synced from canvas
      // Outdoor brightness control: adjusts outdoor areas relative to darkness level
      // At darkness 0: outdoors *= outdoorBrightness (boost daylight)
      // At darkness 1: outdoors *= (2.0 - outdoorBrightness) (dim night)
      outdoorBrightness: 1.5, // 1.0 = no change, 2.0 = double brightness at day

      debugShowLightBuffer: false,
      debugLightBufferExposure: 1.0,
    };

    this.lights = new Map(); // Map<id, ThreeLightSource>
    this.darknessSources = new Map(); // Map<id, ThreeDarknessSource>
    
    // THREE resources
    this.lightScene = null;      // Scene for Light Accumulation
    this.lightTarget = null;     // Buffer for Light Accumulation
    this.darknessScene = null;   // Scene for Darkness Accumulation
    this.darknessTarget = null;  // Buffer for Darkness Accumulation
    this.roofAlphaTarget = null; // Buffer for Roof Alpha Mask (overhead tiles)
    this.quadScene = null;       // Scene for Final Composite
    this.quadCamera = null;
    this.compositeMaterial = null;
    this.debugLightBufferMaterial = null;

    /** @type {THREE.Mesh|null} */
    this._quadMesh = null;

    /** @type {THREE.Texture|null} */
    this.windowMask = null;
    /** @type {THREE.Texture|null} */
    this.outdoorsMask = null;

    /** @type {THREE.Mesh|null} */
    this.windowLightMesh = null;
    /** @type {THREE.ShaderMaterial|null} */
    this.windowLightMaterial = null;

    // Screen-space outdoors mask for overhead shadows: we project the
    // world-space _Outdoors texture from the base plane into a
    // full-screen render target using the main camera so the composite
    // shader can safely sample it with vUv without breaking pinning.
    /** @type {THREE.Scene|null} */
    this.outdoorsScene = null;
    /** @type {THREE.Mesh|null} */
    this.outdoorsMesh = null;
    /** @type {THREE.Material|null} */
    this.outdoorsMaterial = null;
    /** @type {THREE.WebGLRenderTarget|null} */
    this.outdoorsTarget = null;

    this._effectiveDarkness = null;
    
    // PERFORMANCE: Reusable objects to avoid per-frame allocations
    this._tempSize = null; // Lazy init when THREE is available

    /** @type {THREE.Mesh|null} */
    this._baseMesh = null;

    this._publishedRoofAlphaTex = null;
    this._publishedOutdoorsTex = null;
  }

  /**
   * Get UI control schema
   */
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'illumination',
          label: 'Global Illumination',
          type: 'inline',
          parameters: ['globalIllumination', 'lightIntensity']
        },
        {
          name: 'darkness',
          label: 'Darkness Response',
          type: 'inline',
          parameters: ['darknessEffect', 'outdoorBrightness']
        },
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },
        globalIllumination: { type: 'slider', min: 0, max: 2, step: 0.1, default: 1.5 },
        lightIntensity: { type: 'slider', min: 0, max: 2, step: 0.05, default: 0.8, label: 'Light Intensity' },
        darknessEffect: { type: 'slider', min: 0, max: 2, step: 0.05, default: 0.5, label: 'Darkness Effect' },
        outdoorBrightness: { type: 'slider', min: 0.5, max: 2.5, step: 0.05, default: 2.0, label: 'Outdoor Brightness' },
        debugShowLightBuffer: { type: 'boolean', default: false },
        debugLightBufferExposure: { type: 'slider', min: 0.1, max: 10, step: 0.1, default: 1.0 },
      }
    };
  }

  initialize(renderer, scene, camera) {
    const THREE = window.THREE;
    this.renderer = renderer;
    this.mainCamera = camera;

    // 1. Light Accumulation Setup
    this.lightScene = new THREE.Scene();
    // Use black background for additive light accumulation
    this.lightScene.background = new THREE.Color(0x000000); 

    this.darknessScene = new THREE.Scene();
    this.darknessScene.background = new THREE.Color(0x000000);

    // Scene used to project _Outdoors mask from the base plane into
    // screen space for overhead shadow gating.
    this.outdoorsScene = new THREE.Scene();

    this._rebuildOutdoorsProjection();

    // 2. Final Composite Quad
    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    
    // The Composite Shader (Combines Diffuse + Light + Color Correction)
    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, // Base Scene
        tLight: { value: null },   // Accumulated HDR Light
        tDarkness: { value: null }, // Accumulated Darkness Mask
        tRoofAlpha: { value: null }, // Overhead tile alpha mask
        tOverheadShadow: { value: null }, // Overhead shadow factor (from OverheadShadowsEffect)
        tBuildingShadow: { value: null }, // Building shadow factor (from BuildingShadowsEffect)
        tBushShadow: { value: null }, // Bush shadow factor (from BushEffect)
        tTreeShadow: { value: null }, // Tree shadow factor (from TreeEffect)
        tCloudShadow: { value: null }, // Cloud shadow factor (from CloudEffect)
        tCloudTop: { value: null }, // Cloud top overlay (from CloudEffect)
        tOutdoorsMask: { value: null }, // _Outdoors mask (bright outside, dark indoors)
        uDarknessLevel: { value: 0.0 },
        uAmbientBrightest: { value: new THREE.Color(1,1,1) },
        uAmbientDarkness: { value: new THREE.Color(0.1, 0.1, 0.2) },
        uGlobalIllumination: { value: 1.0 },
        uLightIntensity: { value: 1.0 },
        // Overhead & building shadow controls
        uOverheadShadowOpacity: { value: 0.0 },
        uOverheadShadowAffectsLights: { value: 0.75 },
        uBuildingShadowOpacity: { value: 0.0 },
        uBushShadowOpacity: { value: 0.0 },
        uTreeShadowOpacity: { value: 0.0 },
        uTreeSelfShadowStrength: { value: 1.0 },
        uCloudShadowOpacity: { value: 0.0 },
        uHasOutdoorsMask: { value: 0.0 },
        // Shared sun/zoom/texel data for screen-space shadow offsets
        uShadowSunDir: { value: new THREE.Vector2(0, 1) },
        uShadowZoom: { value: 1.0 },
        uBushShadowLength: { value: 0.04 },
        uTreeShadowLength: { value: 0.08 },
        uCompositeTexelSize: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
        // Outdoor brightness boost (applied based on darkness level)
        uOutdoorBrightness: { value: 1.5 },
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
        uniform sampler2D tLight;
        uniform sampler2D tDarkness;
        uniform sampler2D tRoofAlpha;
        uniform sampler2D tOverheadShadow;
        uniform sampler2D tBuildingShadow;
        uniform sampler2D tBushShadow;
        uniform sampler2D tTreeShadow;
        uniform sampler2D tCloudShadow;
        uniform sampler2D tCloudTop;
        uniform sampler2D tOutdoorsMask;
        uniform float uDarknessLevel;
        uniform vec3 uAmbientBrightest;
        uniform vec3 uAmbientDarkness;
        uniform float uGlobalIllumination;
        uniform float uLightIntensity;
        uniform float uOverheadShadowOpacity;
        uniform float uOverheadShadowAffectsLights;
        uniform float uBuildingShadowOpacity;
        uniform float uBushShadowOpacity;
        uniform float uTreeShadowOpacity;
        uniform float uTreeSelfShadowStrength;
        uniform float uCloudShadowOpacity;
        uniform float uHasOutdoorsMask;
        uniform vec2  uShadowSunDir;
        uniform float uShadowZoom;
        uniform float uBushShadowLength;
        uniform float uTreeShadowLength;
        uniform vec2  uCompositeTexelSize;
        uniform float uOutdoorBrightness;
        varying vec2 vUv;

        vec3 adjustSaturation(vec3 color, float value) {
          vec3 gray = vec3(dot(color, vec3(0.2126, 0.7152, 0.0722)));
          return mix(gray, color, value);
        }

        // REINHARD-JODIE TONE MAPPING
        // This compresses high dynamic range values to 0.0 - 1.0
        // while preserving saturation in bright highlights better than standard reinhard.
        vec3 reinhardJodie(vec3 c) {
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          vec3 tc = c / (c + 1.0);
          return mix(c / (l + 1.0), tc, tc);
        }

        void main() {
          vec4 baseColor = texture2D(tDiffuse, vUv);
          vec4 lightSample = texture2D(tLight, vUv); // HDR light buffer
          float darknessMask = clamp(texture2D(tDarkness, vUv).r, 0.0, 1.0);
          vec4 roofSample = texture2D(tRoofAlpha, vUv);

          // 1. Determine Ambient Light
          float master = max(uLightIntensity, 0.0);
          vec3 ambient = mix(uAmbientBrightest, uAmbientDarkness, uDarknessLevel) * max(uGlobalIllumination, 0.0) * master;

          // 2. Roof Occlusion Mask
          float roofAlpha = roofSample.a;
          float lightVisibility = 1.0 - roofAlpha;

          // 3. Shadow Sampling (Overhead, Building, Bush, Tree)
          float shadowTex = texture2D(tOverheadShadow, vUv).r;
          float shadowOpacity = clamp(uOverheadShadowOpacity, 0.0, 1.0);
          float rawShadowFactor = mix(1.0, shadowTex, shadowOpacity);

          float buildingTex = texture2D(tBuildingShadow, vUv).r;
          float buildingOpacity = clamp(uBuildingShadowOpacity, 0.0, 1.0);
          float rawBuildingFactor = mix(1.0, buildingTex, buildingOpacity);

          // Bush Shadows
          vec2 bushDir = normalize(uShadowSunDir);
          float bushPixelLen = uBushShadowLength * 1080.0 * max(uShadowZoom, 0.0001);
          vec2 bushOffsetUv = bushDir * bushPixelLen * uCompositeTexelSize;
          float bushTex = texture2D(tBushShadow, vUv + bushOffsetUv).r;
          float bushOpacity = clamp(uBushShadowOpacity, 0.0, 1.0);
          float rawBushFactor = mix(1.0, bushTex, bushOpacity);

          // Tree Shadows
          float treePixelLen = uTreeShadowLength * 1080.0 * max(uShadowZoom, 0.0001);
          vec2 treeOffsetUv = bushDir * treePixelLen * uCompositeTexelSize;
          float treeTex = texture2D(tTreeShadow, vUv + treeOffsetUv).r;
          float treeOpacity = clamp(uTreeShadowOpacity, 0.0, 1.0);
          float rawTreeFactor = mix(1.0, treeTex, treeOpacity);

          // Cloud Shadows (already masked to outdoors in CloudEffect)
          float cloudTex = texture2D(tCloudShadow, vUv).r;
          float cloudOpacity = clamp(uCloudShadowOpacity, 0.0, 1.0);
          float cloudFactor = mix(1.0, cloudTex, cloudOpacity);

          // Self-masking
          float bushCoverage = texture2D(tBushShadow, vUv).g;
          float bushSelfMask = clamp(bushCoverage, 0.0, 1.0);
          float treeCoverage = texture2D(tTreeShadow, vUv).g;
          float treeSelfMask = clamp(treeCoverage, 0.0, 1.0) * clamp(uTreeSelfShadowStrength, 0.0, 1.0);

          // Shadow mixing logic
          float shadowFactor = mix(rawShadowFactor, 1.0, roofAlpha);
          float buildingFactor = mix(rawBuildingFactor, 1.0, roofAlpha);
          float bushFactor = mix(rawBushFactor, 1.0, roofAlpha);
          float treeFactor = rawTreeFactor;

          bushFactor = mix(bushFactor, 1.0, bushSelfMask);
          treeFactor = mix(treeFactor, 1.0, treeSelfMask);

          if (uHasOutdoorsMask > 0.5) {
            float outdoorStrength = texture2D(tOutdoorsMask, vUv).r;
            shadowFactor = mix(1.0, shadowFactor, outdoorStrength);
            buildingFactor = mix(1.0, buildingFactor, outdoorStrength);
            bushFactor = mix(1.0, bushFactor, outdoorStrength);
            treeFactor = mix(1.0, treeFactor, outdoorStrength);
          }

          float combinedShadowFactor = shadowFactor * buildingFactor * bushFactor * treeFactor * cloudFactor;

          // 4. Combine Ambient with Accumulated Lights
          float kd = clamp(uOverheadShadowAffectsLights, 0.0, 1.0);
          vec3 shadedAmbient = ambient * combinedShadowFactor;

          vec3 baseLights = lightSample.rgb * lightVisibility;

          // Safety check for NaN
          bool badLight = (baseLights.r != baseLights.r) || (baseLights.g != baseLights.g) || (baseLights.b != baseLights.b);
          if (badLight) {
            baseLights = vec3(0.0);
          }

          vec3 shadedLights = mix(baseLights, baseLights * combinedShadowFactor, kd);
          vec3 totalIllumination = shadedAmbient + shadedLights * master;

          float dMask = clamp(darknessMask, 0.0, 1.0);
          totalIllumination *= (1.0 - dMask);

          // Safety check for black flash
          bool badIllum = (totalIllumination.r != totalIllumination.r) ||
                          (totalIllumination.g != totalIllumination.g) ||
                          (totalIllumination.b != totalIllumination.b);
          if (badIllum) {
            totalIllumination = ambient;
          }

          vec3 minIllum = ambient * 0.1;
          totalIllumination = max(totalIllumination, minIllum);
          
          // 5. Apply Illumination to Base Texture
          vec3 litColor = baseColor.rgb * totalIllumination;

          // 6. Apply Outdoor Brightness Boost
          if (uHasOutdoorsMask > 0.5) {
            float outdoorStrength = texture2D(tOutdoorsMask, vUv).r;
            float dayBoost = uOutdoorBrightness;
            float nightDim = 2.0 - uOutdoorBrightness;
            float outdoorMultiplier = mix(dayBoost, nightDim, uDarknessLevel);
            float finalMultiplier = mix(1.0, outdoorMultiplier, outdoorStrength);
            litColor *= finalMultiplier;
          }

          // 7. Blend Cloud Tops over the scene (zoom-dependent white overlay)
          vec4 cloudTop = texture2D(tCloudTop, vUv);
          litColor = mix(litColor, cloudTop.rgb, cloudTop.a);

          gl_FragColor = vec4(litColor, baseColor.a);
        }
      `
    });

    this.debugLightBufferMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tLight: { value: null },
        uExposure: { value: 1.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tLight;
        uniform float uExposure;
        varying vec2 vUv;

        vec3 reinhard(vec3 c) {
          return c / (c + 1.0);
        }

        void main() {
          vec3 c = texture2D(tLight, vUv).rgb * max(uExposure, 0.0);
          c = reinhard(max(c, vec3(0.0)));
          gl_FragColor = vec4(c, 1.0);
        }
      `,
      depthWrite: false,
      depthTest: false,
      transparent: false,
    });
    this.debugLightBufferMaterial.toneMapped = false;

    this._quadMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMaterial);
    this.quadScene.add(this._quadMesh);

    // Hooks to Foundry
    Hooks.on('createAmbientLight', (doc) => this.onLightUpdate(doc));
    Hooks.on('updateAmbientLight', (doc) => this.onLightUpdate(doc));
    Hooks.on('deleteAmbientLight', (doc) => this.onLightDelete(doc));
    
    // Listen for lightingRefresh to rebuild any lights that were created before
    // Foundry computed their LOS polygons (fixes lights extending through walls
    // on initial creation/paste).
    Hooks.on('lightingRefresh', () => this.onLightingRefresh());
    
    // Initial Load
    this.syncAllLights();
  }

  _rebuildOutdoorsProjection() {
    const THREE = window.THREE;
    if (!THREE) return;

    if (this.outdoorsMesh && this.outdoorsScene) {
      this.outdoorsScene.remove(this.outdoorsMesh);
    }
    this.outdoorsMesh = null;
    this.outdoorsMaterial = null;

    if (!this.outdoorsScene || !this.outdoorsMask || !this._baseMesh) {
      return;
    }

    this.outdoorsMaterial = new THREE.MeshBasicMaterial({
      map: this.outdoorsMask,
      transparent: false,
      depthWrite: false,
      depthTest: false
    });

    this.outdoorsMesh = new THREE.Mesh(this._baseMesh.geometry, this.outdoorsMaterial);
    this.outdoorsMesh.position.copy(this._baseMesh.position);
    this.outdoorsMesh.rotation.copy(this._baseMesh.rotation);
    this.outdoorsMesh.scale.copy(this._baseMesh.scale);

    this.outdoorsScene.add(this.outdoorsMesh);
  }

  onResize(width, height) {
    const THREE = window.THREE;
    if (this.lightTarget) this.lightTarget.dispose();
    if (this.darknessTarget) this.darknessTarget.dispose();
    this.lightTarget = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType // HDR capable
    });
  }

  setBaseMesh(baseMesh, assetBundle) {
    const THREE = window.THREE;
    if (!assetBundle || !assetBundle.masks) return;

    this._baseMesh = baseMesh;

    const windowData = assetBundle.masks.find(m => m.id === 'windows' || m.id === 'structural');
    const outdoorsData = assetBundle.masks.find(m => m.id === 'outdoors');

    this.windowMask = windowData?.texture || null;
    this.outdoorsMask = outdoorsData?.texture || null;

    this._rebuildOutdoorsProjection();

    if (!this.windowMask) {
      if (this.windowLightMesh && this.lightScene) {
        this.lightScene.remove(this.windowLightMesh);
      }
      this.windowLightMesh = null;
      this.windowLightMaterial = null;
      return;
    }

    // Create a world-space window light mesh that writes into the light buffer
    const geometry = baseMesh.geometry;

    this.windowLightMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uWindowMask: { value: this.windowMask },
        uOutdoorsMask: { value: this.outdoorsMask },
        uHasOutdoorsMask: { value: this.outdoorsMask ? 1.0 : 0.0 },
        uWindowTexelSize: {
          value: (this.windowMask && this.windowMask.image)
            ? new THREE.Vector2(1 / this.windowMask.image.width, 1 / this.windowMask.image.height)
            : new THREE.Vector2(1 / 1024, 1 / 1024)
        },
        uIntensity: { value: 1.0 },
        uMaskThreshold: { value: 0.1 },
        uSoftness: { value: 0.2 },
        uColor: { value: new THREE.Color(1.0, 0.96, 0.85) },
        uCloudCover: { value: 0.0 },
        uCloudInfluence: { value: 1.0 },
        uMinCloudFactor: { value: 0.0 },
        uCloudLocalInfluence: { value: 1.0 },
        uCloudDensityCurve: { value: 1.0 },
        uCloudShadowMap: { value: null },
        uHasCloudShadowMap: { value: 0.0 },
        uRgbShiftAmount: { value: 0.0 },
        uRgbShiftAngle: { value: 0.0 }
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec4 vClipPos;
        void main() {
          vUv = uv;
          vClipPos = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = vClipPos;
        }
      `,
      fragmentShader: `
        uniform sampler2D uWindowMask;
        uniform sampler2D uOutdoorsMask;
        uniform float uHasOutdoorsMask;
        uniform vec2 uWindowTexelSize;
        uniform float uIntensity;
        uniform float uMaskThreshold;
        uniform float uSoftness;
        uniform vec3 uColor;
        uniform float uCloudCover;
        uniform float uCloudInfluence;
        uniform float uMinCloudFactor;
        uniform float uCloudLocalInfluence;
        uniform float uCloudDensityCurve;
        uniform sampler2D uCloudShadowMap;
        uniform float uHasCloudShadowMap;
        uniform float uRgbShiftAmount;
        uniform float uRgbShiftAngle;

        varying vec2 vUv;
        varying vec4 vClipPos;

        float msLuminance(vec3 c) {
          return dot(c, vec3(0.2126, 0.7152, 0.0722));
        }

        void main() {
          if (uIntensity <= 0.0001) {
            discard;
          }

          vec3 windowSample = texture2D(uWindowMask, vUv).rgb;
          float centerMask = msLuminance(windowSample);

          float blurScale = 1.0 + (uSoftness * 4.0);
          vec2 t = uWindowTexelSize * blurScale;
          float maskN = msLuminance(texture2D(uWindowMask, vUv + vec2(0.0, -t.y)).rgb);
          float maskS = msLuminance(texture2D(uWindowMask, vUv + vec2(0.0,  t.y)).rgb);
          float maskE = msLuminance(texture2D(uWindowMask, vUv + vec2( t.x, 0.0)).rgb);
          float maskW = msLuminance(texture2D(uWindowMask, vUv + vec2(-t.x, 0.0)).rgb);
          float maskNE = msLuminance(texture2D(uWindowMask, vUv + vec2( t.x, -t.y)).rgb);
          float maskNW = msLuminance(texture2D(uWindowMask, vUv + vec2(-t.x, -t.y)).rgb);
          float maskSE = msLuminance(texture2D(uWindowMask, vUv + vec2( t.x,  t.y)).rgb);
          float maskSW = msLuminance(texture2D(uWindowMask, vUv + vec2(-t.x,  t.y)).rgb);

          float baseMask = (centerMask * 2.0 + maskN + maskS + maskE + maskW + maskNE + maskNW + maskSE + maskSW) / 10.0;

          float halfWidth = max(uSoftness, 1e-3);
          float edgeLo = clamp(uMaskThreshold - halfWidth, 0.0, 1.0);
          float edgeHi = clamp(uMaskThreshold + halfWidth, 0.0, 1.0);
          float m = smoothstep(edgeLo, edgeHi, baseMask);
          if (m <= 0.0) discard;

          float indoor = 1.0;
          if (uHasOutdoorsMask > 0.5) {
            float outdoorStrength = texture2D(uOutdoorsMask, vUv).r;
            indoor = 1.0 - outdoorStrength;
            if (indoor <= 0.0) discard;
          }

          // Cloud attenuation
          // Do NOT use raw cloud cover (slider) for window light. The only thing
          // that should dim this effect is the presence/content of the cloud
          // density texture produced by CloudEffect.
          float cloudFactor = 1.0;

          // Sample cloud SHADOW FACTOR texture for spatial variation (animated clouds passing by)
          // CloudEffect provides *shadow factor* (1 = fully lit, 0 = fully shadowed).
          if (uHasCloudShadowMap > 0.5) {
            // Cloud density is rendered in SCREEN SPACE, convert clip coords to screen UV
            vec2 screenUV = (vClipPos.xy / vClipPos.w) * 0.5 + 0.5;
            float shadowFactor = texture2D(uCloudShadowMap, screenUV).r;

            // Curve shaping: higher values make midtones darker (stronger shadows).
            float curve = max(uCloudDensityCurve, 0.001);
            shadowFactor = pow(clamp(shadowFactor, 0.0, 1.0), curve);

            // uCloudLocalInfluence is exposed as [0,3] in UI. Remap to [0,1]
            // so we don't extrapolate past 0..1 and accidentally invert/destroy intensity.
            float localMix = clamp(uCloudLocalInfluence / 3.0, 0.0, 1.0);
            cloudFactor = mix(1.0, shadowFactor, localMix);
          }

          cloudFactor = max(cloudFactor, uMinCloudFactor);

          // Apply global influence shaping. When influence is high, clouds dim harder.
          // influence = 0 => ignore clouds.
          if (uCloudInfluence > 0.0001) {
            cloudFactor = pow(max(cloudFactor, 1e-4), uCloudInfluence);
          } else {
            cloudFactor = 1.0;
          }

          float strength = m * indoor * cloudFactor * uIntensity;

          vec3 lightColor = uColor * strength;

          if (uRgbShiftAmount > 0.0001) {
            float angle = uRgbShiftAngle;
            vec2 dir = vec2(cos(angle), sin(angle));
            vec2 shift = dir * uRgbShiftAmount * uWindowTexelSize;

            float maskR = msLuminance(texture2D(uWindowMask, vUv + shift).rgb);
            float maskG = baseMask;
            float maskB = msLuminance(texture2D(uWindowMask, vUv - shift).rgb);

            float denom = max(baseMask, 1e-3);
            float rScale = maskR / denom;
            float gScale = maskG / denom;
            float bScale = maskB / denom;

            lightColor.r *= rScale;
            lightColor.g *= gScale;
            lightColor.b *= bScale;
          }

          gl_FragColor = vec4(lightColor, 1.0);
        }
      `,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: true
    });

    this.windowLightMesh = new THREE.Mesh(geometry, this.windowLightMaterial);
    this.windowLightMesh.position.copy(baseMesh.position);
    this.windowLightMesh.rotation.copy(baseMesh.rotation);
    this.windowLightMesh.scale.copy(baseMesh.scale);

    if (this.lightScene) {
      this.lightScene.add(this.windowLightMesh);
    }

    this._rebuildOutdoorsProjection();
  }

  syncAllLights() {
    if (!canvas.lighting) return;
    this.lights.forEach(l => l.dispose());
    this.lights.clear();
    this.darknessSources.forEach(d => d.dispose());
    this.darknessSources.clear();
    canvas.lighting.placeables.forEach(p => this.onLightUpdate(p.document));
  }

  /**
   * Called when Foundry finishes computing LOS polygons for all lights.
   * Rebuilds any lights that were created before their LOS was available.
   */
  onLightingRefresh() {
    if (!canvas.lighting) return;

    this.lights.forEach((source) => {
      if (!source) return;
      if (!source._usingCircleFallback) return;

      try {
        // Force geometry rebuild now that LOS should be available.
        source.updateData(source.document, true);

        // Ensure the mesh is attached to the light scene.
        if (source.mesh && this.lightScene && !source.mesh.parent) {
          this.lightScene.add(source.mesh);
        }
      } catch (e) {
      }
    });
  }

  onLightUpdate(doc) {
    console.debug('[LightingEffect] onLightUpdate', doc.id, doc.config?.negative, doc.config);
    if (doc?.config?.negative) {
      console.debug('[LightingEffect] Creating/Updating darkness source for', doc.id);
      if (this.darknessSources.has(doc.id)) {
        this.darknessSources.get(doc.id).updateData(doc);
      } else {
        const source = new ThreeDarknessSource(doc);
        source.init();
        this.darknessSources.set(doc.id, source);
        if (source.mesh && this.darknessScene) this.darknessScene.add(source.mesh);
        console.debug('[LightingEffect] Added darkness mesh to scene', doc.id);
      }
      if (this.lights.has(doc.id)) {
        const source = this.lights.get(doc.id);
        if (source?.mesh) this.lightScene?.remove(source.mesh);
        source?.dispose();
        this.lights.delete(doc.id);
      }
      return;
    }

    if (this.darknessSources.has(doc.id)) {
      const ds = this.darknessSources.get(doc.id);
      if (ds?.mesh && this.darknessScene) this.darknessScene.remove(ds.mesh);
      ds?.dispose();
      this.darknessSources.delete(doc.id);
    }

    if (this.lights.has(doc.id)) {
      this.lights.get(doc.id).updateData(doc);
    } else {
      const source = new ThreeLightSource(doc);
      source.init();
      this.lights.set(doc.id, source);
      if (source.mesh) this.lightScene.add(source.mesh);
    }
  }

  onLightDelete(doc) {
    if (this.darknessSources.has(doc.id)) {
      const source = this.darknessSources.get(doc.id);
      if (source.mesh && this.darknessScene) this.darknessScene.remove(source.mesh);
      source.dispose();
      this.darknessSources.delete(doc.id);
    }

    if (this.lights.has(doc.id)) {
      const source = this.lights.get(doc.id);
      if (source.mesh) this.lightScene.remove(source.mesh);
      source.dispose();
      this.lights.delete(doc.id);
    }
  }

  getEffectiveDarkness() {
    let d = this.params?.darknessLevel;
    try {
      const env = canvas?.environment;
      if (env && typeof env.darknessLevel === 'number') {
        d = env.darknessLevel;
      }
    } catch (e) {
    }

    d = (typeof d === 'number' && isFinite(d)) ? d : 0.0;
    const scale = (typeof this.params?.darknessEffect === 'number' && isFinite(this.params.darknessEffect))
      ? this.params.darknessEffect
      : 1.0;

    const eff = Math.max(0.0, Math.min(1.0, d * scale));
    this._effectiveDarkness = eff;
    return eff;
  }

  update(timeInfo) {
    if (DISABLE_LIGHTING_EFFECT) return;
    if (!this.enabled) return;

    const THREE = window.THREE;

    const setThreeColorLoose = (target, input, fallback = 0xffffff) => {
      try {
        if (!target) return;
        if (input && typeof input === 'object' && 'r' in input && 'g' in input && 'b' in input) {
          target.set(input.r, input.g, input.b);
          return;
        }
        if (typeof input === 'string' || typeof input === 'number') {
          target.set(input);
          return;
        }
        target.set(fallback);
      } catch (e) {
        try {
          target.set(fallback);
        } catch (e2) {}
      }
    };

    // Sync Environment Data
    if (canvas.scene && canvas.environment) {
      this.params.darknessLevel = canvas.environment.darknessLevel;
      // (Ambient colors sync omitted here to keep this patch focused.)
    }

    // Update Animations for all lights
    this.lights.forEach(light => {
      light.updateAnimation(timeInfo, this.params.darknessLevel);
    });

    // Update Animations for all darkness sources
    this.darknessSources.forEach(ds => {
      ds.updateAnimation(timeInfo);
    });

    // Update Composite Uniforms
    const u = this.compositeMaterial.uniforms;
    u.uDarknessLevel.value = this.getEffectiveDarkness();
    u.uGlobalIllumination.value = this.params.globalIllumination;
    u.uLightIntensity.value = this.params.lightIntensity;
    u.uOutdoorBrightness.value = this.params.outdoorBrightness;

    try {
      const env = canvas?.environment;
      const setThreeColor = (target, src, def) => {
        try {
          if (!src) { target.set(def); return; }
          if (src instanceof THREE.Color) { target.copy(src); return; }
          if (src.rgb) { target.setRGB(src.rgb[0], src.rgb[1], src.rgb[2]); return; }
          if (Array.isArray(src)) { target.setRGB(src[0], src[1], src[2]); return; }
          target.set(src);
        } catch (e) {
          target.set(def);
        }
      };

      if (THREE && env?.colors && u.uAmbientBrightest?.value && u.uAmbientDarkness?.value) {
        setThreeColor(u.uAmbientBrightest.value, env.colors.ambientDaylight, 0xffffff);
        setThreeColor(u.uAmbientDarkness.value, env.colors.ambientDarkness, 0x242448);
      }
    } catch (e) {
    }

    // Drive overhead shadow uniforms from OverheadShadowsEffect (if present).
    try {
      const overhead = window.MapShine?.overheadShadowsEffect;
      if (overhead && overhead.params && overhead.enabled && overhead.shadowTarget) {
        u.uOverheadShadowOpacity.value = overhead.params.opacity ?? 0.0;
        u.uOverheadShadowAffectsLights.value = overhead.params.affectsLights ?? 0.75;
      } else {
        // No active overhead shadows; disable effect in shader.
        u.uOverheadShadowOpacity.value = 0.0;
      }
    } catch (e) {
      u.uOverheadShadowOpacity.value = 0.0;
    }

    // Drive building shadow opacity from BuildingShadowsEffect (if present).
    try {
      const building = window.MapShine?.buildingShadowsEffect;
      if (building && building.params && building.enabled && building.shadowTarget) {
        const baseOpacity = building.params.opacity ?? 0.0;
        const ti = (typeof building.timeIntensity === 'number')
          ? THREE.MathUtils.clamp(building.timeIntensity, 0.0, 1.0)
          : 1.0;
        u.uBuildingShadowOpacity.value = baseOpacity * ti;
      } else {
        u.uBuildingShadowOpacity.value = 0.0;
      }
    } catch (e) {
      u.uBuildingShadowOpacity.value = 0.0;
    }

    // Drive bush shadow opacity and length from BushEffect (if present).
    try {
      const bush = window.MapShine?.bushEffect;
      if (bush && bush.params && bush.enabled && bush.shadowTarget) {
        const baseOpacity = bush.params.shadowOpacity ?? 0.0;
        u.uBushShadowOpacity.value = baseOpacity;
        if (typeof bush.params.shadowLength === 'number') {
          u.uBushShadowLength.value = bush.params.shadowLength;
        }
      } else {
        u.uBushShadowOpacity.value = 0.0;
      }
    } catch (e) {
      u.uBushShadowOpacity.value = 0.0;
    }

    // Drive tree shadow opacity, length, and self-shadow behavior from TreeEffect (if present).
    try {
      const tree = window.MapShine?.treeEffect;
      if (tree && tree.params && tree.enabled && tree.shadowTarget) {
        const baseOpacity = tree.params.shadowOpacity ?? 0.0;
        u.uTreeShadowOpacity.value = baseOpacity;
        if (typeof tree.params.shadowLength === 'number') {
          u.uTreeShadowLength.value = tree.params.shadowLength;
        }

        let selfStrength = 1.0;
        if (typeof tree.getHoverFade === 'function') {
          const f = tree.getHoverFade();
          if (typeof f === 'number' && isFinite(f)) {
            selfStrength = Math.max(0.0, Math.min(1.0, f));
          }
        }
        u.uTreeSelfShadowStrength.value = selfStrength;
      } else {
        u.uTreeShadowOpacity.value = 0.0;
        u.uTreeSelfShadowStrength.value = 1.0;
      }
    } catch (e) {
      u.uTreeShadowOpacity.value = 0.0;
      u.uTreeSelfShadowStrength.value = 1.0;
    }

    // Window light uniforms driven by WeatherController and WindowLightEffect
    let cloudCover = 0.0;
    try {
      const state = weatherController?.getCurrentState?.();
      if (state && typeof state.cloudCover === 'number') {
        cloudCover = state.cloudCover;
      }
    } catch (e) {
      // ignore
    }

    if (this.windowLightMaterial) {
      const wu = this.windowLightMaterial.uniforms;
      wu.uCloudCover.value = cloudCover;

      const wl = window.MapShine?.windowLightEffect;
      const wlActive = !!(wl && wl.enabled && wl.params && wl.params.hasWindowMask);
      if (this.windowLightMesh) this.windowLightMesh.visible = wlActive;

      if (wlActive) {
        wu.uIntensity.value = wl.params.intensity ?? wu.uIntensity.value;
        wu.uMaskThreshold.value = wl.params.maskThreshold ?? wu.uMaskThreshold.value;
        wu.uSoftness.value = wl.params.softness ?? wu.uSoftness.value;
        wu.uCloudInfluence.value = wl.params.cloudInfluence ?? wu.uCloudInfluence.value;
        wu.uMinCloudFactor.value = wl.params.minCloudFactor ?? wu.uMinCloudFactor.value;
        wu.uCloudLocalInfluence.value = wl.params.cloudLocalInfluence ?? wu.uCloudLocalInfluence.value;
        wu.uCloudDensityCurve.value = wl.params.cloudDensityCurve ?? wu.uCloudDensityCurve.value;
        wu.uRgbShiftAmount.value = wl.params.rgbShiftAmount ?? wu.uRgbShiftAmount.value;
        if (typeof wl.params.rgbShiftAngle === 'number') {
          wu.uRgbShiftAngle.value = wl.params.rgbShiftAngle * (Math.PI / 180.0);
        }
        setThreeColorLoose(wu.uColor.value, wl.params.color, 0xfff5dd);
      } else {
        wu.uIntensity.value = 0.0;
        wu.uHasCloudShadowMap.value = 0.0;
      }
      
      // Bind cloud DENSITY texture for spatially-varying dimming (not outdoors-masked shadow)
      try {
        const cloudEffect = window.MapShine?.cloudEffect;
        const mm = window.MapShine?.maskManager;
        const shadowRaw = mm ? mm.getTexture('cloudShadowRaw.screen') : null;
        if (wlActive && shadowRaw) {
          wu.uCloudShadowMap.value = shadowRaw;
          wu.uHasCloudShadowMap.value = 1.0;
        } else if (wlActive && cloudEffect?.cloudShadowRawTarget?.texture && cloudEffect.enabled) {
          wu.uCloudShadowMap.value = cloudEffect.cloudShadowRawTarget.texture;
          wu.uHasCloudShadowMap.value = 1.0;
        } else {
          wu.uCloudShadowMap.value = null;
          wu.uHasCloudShadowMap.value = 0.0;
        }
      } catch (e) {
        wu.uHasCloudShadowMap.value = 0.0;
      }
    }

    // --- Shared sun/zoom data for screen-space shadows (overhead, building, bush) ---
    try {
      const overhead = window.MapShine?.overheadShadowsEffect;
      const THREE = window.THREE;

      if (overhead && overhead.sunDir && THREE) {
        u.uShadowSunDir.value.copy(overhead.sunDir);
      } else if (weatherController && THREE) {
        // Fallback: recompute sunDir from WeatherController.timeOfDay and
        // overhead sunLatitude, mirroring OverheadShadowsEffect logic.
        let hour = 12.0;
        try {
          if (typeof weatherController.timeOfDay === 'number') {
            hour = weatherController.timeOfDay;
          }
        } catch (e) {}

        const t = (hour % 24.0) / 24.0;
        const azimuth = (t - 0.5) * Math.PI;
        const lat = (overhead && overhead.params && typeof overhead.params.sunLatitude === 'number')
          ? THREE.MathUtils.clamp(overhead.params.sunLatitude, 0.0, 1.0)
          : 0.5;
        const x = -Math.sin(azimuth);
        const y = Math.cos(azimuth) * lat;
        u.uShadowSunDir.value.set(x, y);
      }

      // Zoom factor - works with both OrthographicCamera and PerspectiveCamera
      if (this.mainCamera) {
        u.uShadowZoom.value = this._getEffectiveZoom();
      }
    } catch (e) {
      // keep previous values
    }
  }

  render(renderer, scene, camera) {
    if (DISABLE_LIGHTING_EFFECT) return;
    if (!this.enabled) return;

    const THREE = window.THREE;

    // Ensure we have a light accumulation target that matches the current
    // drawing buffer size. This avoids a black screen if onResize has not
    // been called yet.
    // PERFORMANCE: Reuse Vector2 instead of allocating every frame
    if (!this._tempSize) this._tempSize = new THREE.Vector2();
    const size = this._tempSize;
    renderer.getDrawingBufferSize(size);

    if (!this.lightTarget) {
      this.lightTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.HalfFloatType // HDR capable
      });
    } else if (this.lightTarget.width !== size.x || this.lightTarget.height !== size.y) {
      this.lightTarget.setSize(size.x, size.y);
    }

    if (!this.darknessTarget) {
      this.darknessTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else if (this.darknessTarget.width !== size.x || this.darknessTarget.height !== size.y) {
      this.darknessTarget.setSize(size.x, size.y);
    }

    if (!this.roofAlphaTarget) {
      this.roofAlphaTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else if (this.roofAlphaTarget.width !== size.x || this.roofAlphaTarget.height !== size.y) {
      this.roofAlphaTarget.setSize(size.x, size.y);
    }

    const hasOutdoorsProjection = !!(this.outdoorsScene && this.outdoorsMesh && this.outdoorsMask);
    if (hasOutdoorsProjection) {
      if (!this.outdoorsTarget) {
        this.outdoorsTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          format: THREE.RGBAFormat,
          type: THREE.UnsignedByteType
        });
      } else if (this.outdoorsTarget.width !== size.x || this.outdoorsTarget.height !== size.y) {
        this.outdoorsTarget.setSize(size.x, size.y);
      }
    }

    try {
      const mm = window.MapShine?.maskManager;
      if (mm) {
        const roofTex = this.roofAlphaTarget?.texture;
        if (roofTex && roofTex !== this._publishedRoofAlphaTex) {
          this._publishedRoofAlphaTex = roofTex;
          mm.setTexture('roofAlpha.screen', roofTex, {
            space: 'screenUv',
            source: 'renderTarget',
            channels: 'a',
            uvFlipY: false,
            lifecycle: 'dynamicPerFrame',
            width: this.roofAlphaTarget?.width ?? null,
            height: this.roofAlphaTarget?.height ?? null
          });
        }

        const outdoorsTex = this.outdoorsTarget?.texture;
        if (outdoorsTex && outdoorsTex !== this._publishedOutdoorsTex) {
          this._publishedOutdoorsTex = outdoorsTex;
          mm.setTexture('outdoors.screen', outdoorsTex, {
            space: 'screenUv',
            source: 'renderTarget',
            channels: 'r',
            uvFlipY: false,
            lifecycle: 'dynamicPerFrame',
            width: this.outdoorsTarget?.width ?? null,
            height: this.outdoorsTarget?.height ?? null
          });
        }
      }
    } catch (e) {
    }

    // 0. Render Roof Alpha Mask (overhead tiles only)
    // We rely on TileManager tagging overhead tiles into ROOF_LAYER (20).
    const ROOF_LAYER = 20;
    const previousLayersMask = this.mainCamera.layers.mask;
    const previousTarget = renderer.getRenderTarget();

    this.mainCamera.layers.set(ROOF_LAYER);
    renderer.setRenderTarget(this.roofAlphaTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, this.mainCamera);

    // Restore camera layers and render target
    this.mainCamera.layers.mask = previousLayersMask;
    renderer.setRenderTarget(previousTarget);

    // 0.5 Render screen-space _Outdoors mask from the base plane only
    // into outdoorsTarget using the main camera. This produces a
    // screen-aligned outdoors factor we can safely sample with vUv in
    // the composite shader without introducing world-space pinning
    // errors.
    if (hasOutdoorsProjection && this.outdoorsTarget) {
      const prevTarget2 = renderer.getRenderTarget();
      renderer.setRenderTarget(this.outdoorsTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(this.outdoorsScene, this.mainCamera);
      renderer.setRenderTarget(prevTarget2);
    }

    // 1. Accumulate Lights into lightTarget
    const oldTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.lightTarget);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();

    if (this.lightScene && this.mainCamera) {
      const prevMask = this.mainCamera.layers.mask;
      try {
        // Always include default layer 0 and our overlay layer during light accumulation.
        this.mainCamera.layers.enable(0);
        this.mainCamera.layers.enable(OVERLAY_THREE_LAYER);
        renderer.render(this.lightScene, this.mainCamera);
      } finally {
        this.mainCamera.layers.mask = prevMask;
      }
    }

    // 1.5 Accumulate Darkness into darknessTarget
    renderer.setRenderTarget(this.darknessTarget);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    if (this.darknessScene && this.mainCamera) {
      renderer.render(this.darknessScene, this.mainCamera);
    }

    // 2. Composite: use lightTarget as tLight and roofAlphaTarget as tRoofAlpha.
    // Base scene texture comes from EffectComposer via setInputTexture(tDiffuse).
    const cu = this.compositeMaterial.uniforms;
    cu.tLight.value = this.lightTarget.texture;
    cu.tDarkness.value = this.darknessTarget.texture;
    cu.tRoofAlpha.value = this.roofAlphaTarget.texture;

    // Bind screen-space outdoors mask so we can avoid darkening
    // building interiors in a way that is correctly pinned to the
    // groundplane.
    cu.tOutdoorsMask.value = (hasOutdoorsProjection && this.outdoorsTarget && this.outdoorsTarget.texture)
      ? this.outdoorsTarget.texture
      : null;
    cu.uHasOutdoorsMask.value = hasOutdoorsProjection ? 1.0 : 0.0;

    // Bind overhead shadow texture if available.
    try {
      const overhead = window.MapShine?.overheadShadowsEffect;
      cu.tOverheadShadow.value = (overhead && overhead.shadowTarget)
        ? overhead.shadowTarget.texture
        : null;
    } catch (e) {
      cu.tOverheadShadow.value = null;
    }

    // Bind building shadow texture if available.
    try {
      const building = window.MapShine?.buildingShadowsEffect;
      cu.tBuildingShadow.value = (building && building.shadowTarget)
        ? building.shadowTarget.texture
        : null;
    } catch (e) {
      cu.tBuildingShadow.value = null;
    }

    // Bind bush shadow texture if available.
    try {
      const bush = window.MapShine?.bushEffect;
      cu.tBushShadow.value = (bush && bush.shadowTarget)
        ? bush.shadowTarget.texture
        : null;
    } catch (e) {
      cu.tBushShadow.value = null;
    }

    // Bind tree shadow texture if available.
    try {
      const tree = window.MapShine?.treeEffect;
      cu.tTreeShadow.value = (tree && tree.shadowTarget)
        ? tree.shadowTarget.texture
        : null;
    } catch (e) {
      cu.tTreeShadow.value = null;
    }

    // Bind cloud shadow and cloud top textures if available.
    try {
      const cloud = window.MapShine?.cloudEffect;
      cu.tCloudShadow.value = (cloud && cloud.cloudShadowTarget)
        ? cloud.cloudShadowTarget.texture
        : null;
      cu.tCloudTop.value = (cloud && cloud.cloudTopTarget)
        ? cloud.cloudTopTarget.texture
        : null;
      // Drive cloud shadow opacity from CloudEffect params
      cu.uCloudShadowOpacity.value = (cloud && cloud.enabled && cloud.params)
        ? cloud.params.shadowOpacity
        : 0.0;
    } catch (e) {
      cu.tCloudShadow.value = null;
      cu.tCloudTop.value = null;
      cu.uCloudShadowOpacity.value = 0.0;
    }

    renderer.setRenderTarget(oldTarget);

    if (this.params?.debugShowLightBuffer && this._quadMesh && this.debugLightBufferMaterial) {
      this.debugLightBufferMaterial.uniforms.tLight.value = this.lightTarget.texture;
      this.debugLightBufferMaterial.uniforms.uExposure.value = this.params.debugLightBufferExposure ?? 1.0;
      this._quadMesh.material = this.debugLightBufferMaterial;
    } else if (this._quadMesh) {
      this._quadMesh.material = this.compositeMaterial;
    }

    renderer.render(this.quadScene, this.quadCamera);
  }

  setInputTexture(texture) {
    if (this.compositeMaterial) {
      this.compositeMaterial.uniforms.tDiffuse.value = texture;
    }
  }
}