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

const log = createLogger('LightingEffect');

export class LightingEffect extends EffectBase {
  constructor() {
    super('lighting', RenderLayers.POST_PROCESSING, 'low');
    
    this.priority = 1; 
    
    // UI Parameters matching Foundry VTT + Custom Tweaks
    this.params = {
      enabled: true,
      globalIllumination: 1.4, // Multiplier for ambient
      lightIntensity: 0.8, // Master multiplier for dynamic lights (tuned default)
      darknessEffect: 0.5, // Scales Foundry's darknessLevel (tuned default)
      exposure: 0.8,
      saturation: 1.0,
      contrast: 1.0,
      darknessLevel: 0.0, // Read-only mostly, synced from canvas
    };

    this.lights = new Map(); // Map<id, ThreeLightSource>
    
    // THREE resources
    this.lightScene = null;      // Scene for Light Accumulation
    this.lightTarget = null;     // Buffer for Light Accumulation
    this.roofAlphaTarget = null; // Buffer for Roof Alpha Mask (overhead tiles)
    this.quadScene = null;       // Scene for Final Composite
    this.quadCamera = null;
    this.compositeMaterial = null;

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
          parameters: ['darknessEffect']
        },
        {
          name: 'correction',
          label: 'Color Correction',
          type: 'inline',
          parameters: ['exposure', 'saturation', 'contrast']
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },
        globalIllumination: { type: 'slider', min: 0, max: 2, step: 0.1, default: 1.4 },
        lightIntensity: { type: 'slider', min: 0, max: 2, step: 0.05, default: 0.8, label: 'Light Intensity' },
        darknessEffect: { type: 'slider', min: 0, max: 2, step: 0.05, default: 0.5, label: 'Darkness Effect' },
        exposure: { type: 'slider', min: -1, max: 1, step: 0.1, default: 0.8 },
        saturation: { type: 'slider', min: 0, max: 2, step: 0.1, default: 1.0 },
        contrast: { type: 'slider', min: 0.5, max: 1.5, step: 0.05, default: 1.0 },
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

    // Scene used to project _Outdoors mask from the base plane into
    // screen space for overhead shadow gating.
    this.outdoorsScene = new THREE.Scene();

    // 2. Final Composite Quad
    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    
    // The Composite Shader (Combines Diffuse + Light + Color Correction)
    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, // Base Scene
        tLight: { value: null },   // Accumulated HDR Light
        tRoofAlpha: { value: null }, // Overhead tile alpha mask
        tOverheadShadow: { value: null }, // Overhead shadow factor (from OverheadShadowsEffect)
        tBuildingShadow: { value: null }, // Building shadow factor (from BuildingShadowsEffect)
        tBushShadow: { value: null }, // Bush shadow factor (from BushEffect)
        tTreeShadow: { value: null }, // Tree shadow factor (from TreeEffect)
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
        uHasOutdoorsMask: { value: 0.0 },
        // Shared sun/zoom/texel data for screen-space shadow offsets
        uShadowSunDir: { value: new THREE.Vector2(0, 1) },
        uShadowZoom: { value: 1.0 },
        uBushShadowLength: { value: 0.04 },
        uTreeShadowLength: { value: 0.08 },
        uCompositeTexelSize: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
        // Post-process settings
        uExposure: { value: 0.0 },
        uSaturation: { value: 1.0 },
        uContrast: { value: 1.0 }
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
        uniform sampler2D tRoofAlpha;
        uniform sampler2D tOverheadShadow;
        uniform sampler2D tBuildingShadow;
        uniform sampler2D tBushShadow;
        uniform sampler2D tTreeShadow;
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
        uniform float uHasOutdoorsMask;
        uniform vec2  uShadowSunDir;
        uniform float uShadowZoom;
        uniform float uBushShadowLength;
        uniform float uTreeShadowLength;
        uniform vec2  uCompositeTexelSize;
        uniform float uExposure;
        uniform float uSaturation;
        uniform float uContrast;
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

          float combinedShadowFactor = shadowFactor * buildingFactor * bushFactor * treeFactor;

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
          // We calculate the raw HDR color first
          vec3 hdrColor = baseColor.rgb * totalIllumination;

          // --- POST PROCESSING ---

          // Exposure (Applied in linear HDR space)
          // Note: Since tone mapping compresses brightness, you might need to
          // bump your default uExposure slightly if the map feels too dark.
          hdrColor *= pow(2.0, uExposure);

          // Apply Tone Mapping (Reinhard-Jodie)
          // This maps (0 -> Infinity) to (0 -> 1) smoothly.
          vec3 toneMappedColor = reinhardJodie(hdrColor);

          // Contrast (Applied after tone mapping handles the range compression)
          vec3 finalRGB = (toneMappedColor - 0.5) * uContrast + 0.5;

          // Saturation
          finalRGB = adjustSaturation(finalRGB, uSaturation);

          gl_FragColor = vec4(finalRGB, baseColor.a);
        }
      `
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMaterial);
    this.quadScene.add(quad);

    // Hooks to Foundry
    Hooks.on('createAmbientLight', (doc) => this.onLightUpdate(doc));
    Hooks.on('updateAmbientLight', (doc) => this.onLightUpdate(doc));
    Hooks.on('deleteAmbientLight', (doc) => this.onLightDelete(doc));
    
    // Initial Load
    this.syncAllLights();
  }

  onResize(width, height) {
    const THREE = window.THREE;
    if (this.lightTarget) this.lightTarget.dispose();
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

    const windowData = assetBundle.masks.find(m => m.id === 'windows' || m.id === 'structural');
    const outdoorsData = assetBundle.masks.find(m => m.id === 'outdoors');

    this.windowMask = windowData?.texture || null;
    this.outdoorsMask = outdoorsData?.texture || null;

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
        uRgbShiftAmount: { value: 0.0 },
        uRgbShiftAngle: { value: 0.0 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
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
        uniform float uRgbShiftAmount;
        uniform float uRgbShiftAngle;

        varying vec2 vUv;

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

          float cloud = clamp(uCloudCover, 0.0, 1.0);
          float cloudFactor = 1.0 - (cloud * 0.8 * uCloudInfluence);
          cloudFactor = max(cloudFactor, uMinCloudFactor);

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

    // Build a dedicated outdoors projection mesh so we can render the
    // _Outdoors mask into a screen-space texture (outdoorsTarget) for
    // overhead shadow gating in the composite shader.
    if (this.outdoorsScene && this.outdoorsMask) {
      if (this.outdoorsMesh && this.outdoorsScene) {
        this.outdoorsScene.remove(this.outdoorsMesh);
      }

      this.outdoorsMaterial = new THREE.MeshBasicMaterial({
        map: this.outdoorsMask,
        transparent: false,
        depthWrite: false,
        depthTest: false
      });

      this.outdoorsMesh = new THREE.Mesh(baseMesh.geometry, this.outdoorsMaterial);
      this.outdoorsMesh.position.copy(baseMesh.position);
      this.outdoorsMesh.rotation.copy(baseMesh.rotation);
      this.outdoorsMesh.scale.copy(baseMesh.scale);

      this.outdoorsScene.add(this.outdoorsMesh);
    } else {
      this.outdoorsMesh = null;
      this.outdoorsMaterial = null;
    }
  }

  syncAllLights() {
    if (!canvas.lighting) return;
    this.lights.forEach(l => l.dispose());
    this.lights.clear();
    canvas.lighting.placeables.forEach(p => this.onLightUpdate(p.document));
  }

  onLightUpdate(doc) {
    if (this.lights.has(doc.id)) {
      this.lights.get(doc.id).updateData(doc);
    } else {
      const source = new ThreeLightSource(doc);
      this.lights.set(doc.id, source);
      if (source.mesh) this.lightScene.add(source.mesh);
    }
  }

  onLightDelete(doc) {
    if (this.lights.has(doc.id)) {
      const source = this.lights.get(doc.id);
      if (source.mesh) this.lightScene.remove(source.mesh);
      source.dispose();
      this.lights.delete(doc.id);
    }
  }

  update(timeInfo) {
    if (!this.enabled) return;

    const dt = timeInfo && typeof timeInfo.delta === 'number' ? timeInfo.delta : 0;

    // Sync Environment Data
    if (canvas.scene && canvas.environment) {
      this.params.darknessLevel = canvas.environment.darknessLevel;
      // (Ambient colors sync omitted here to keep this patch focused.)
    }

    // Update Animations for all lights
    this.lights.forEach(light => {
      light.updateAnimation(dt, this.params.darknessLevel);
    });

    // Update Composite Uniforms
    const u = this.compositeMaterial.uniforms;
    u.uDarknessLevel.value = this.getEffectiveDarkness();
    u.uGlobalIllumination.value = this.params.globalIllumination;
    u.uLightIntensity.value = this.params.lightIntensity;
    u.uExposure.value = this.params.exposure;
    u.uSaturation.value = this.params.saturation;
    u.uContrast.value = this.params.contrast;

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
      if (wl && wl.params) {
        wu.uIntensity.value = wl.params.intensity ?? wu.uIntensity.value;
        wu.uMaskThreshold.value = wl.params.maskThreshold ?? wu.uMaskThreshold.value;
        wu.uSoftness.value = wl.params.softness ?? wu.uSoftness.value;
        wu.uCloudInfluence.value = wl.params.cloudInfluence ?? wu.uCloudInfluence.value;
        wu.uMinCloudFactor.value = wl.params.minCloudFactor ?? wu.uMinCloudFactor.value;
        wu.uRgbShiftAmount.value = wl.params.rgbShiftAmount ?? wu.uRgbShiftAmount.value;
        if (typeof wl.params.rgbShiftAngle === 'number') {
          wu.uRgbShiftAngle.value = wl.params.rgbShiftAngle * (Math.PI / 180.0);
        }
        if (wl.params.color) {
          wu.uColor.value.set(wl.params.color.r, wl.params.color.g, wl.params.color.b);
        }
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

      // Zoom factor matching OverheadShadowsEffect logic (camera dolly zoom).
      if (this.mainCamera && THREE) {
        const baseDist = 10000.0;
        const dist = this.mainCamera.position.z;
        const z = (dist > 0.1) ? (baseDist / dist) : 1.0;
        u.uShadowZoom.value = z;
      }
    } catch (e) {
      // keep previous values
    }
  }

  getEffectiveDarkness() {
    let darkness = 0.0;
    try {
      if (typeof this.params.darknessLevel === 'number') {
        darkness = this.params.darknessLevel;
      }
      // Baseline compression so that raw darkness 1.0 is not fully black.
      // With baseScale = 0.75 and darknessEffect = 1.0, raw 1.0 -> effective 0.75.
      const baseScale = 0.75;
      const userScale = (typeof this.params.darknessEffect === 'number')
        ? this.params.darknessEffect
        : 1.0;
      darkness *= baseScale * userScale;
      const THREE = window.THREE;
      if (THREE && THREE.MathUtils) {
        darkness = THREE.MathUtils.clamp(darkness, 0.0, 1.0);
      } else {
        darkness = Math.max(0, Math.min(1, darkness));
      }
    } catch (e) {
      darkness = 0.0;
    }

    this._effectiveDarkness = darkness;
    if (window.MapShine) {
      window.MapShine.effectiveDarkness = darkness;
    }
    return darkness;
  }

  render(renderer, scene, camera) {
    if (!this.enabled) return;

    const THREE = window.THREE;

    // Ensure we have a light accumulation target that matches the current
    // drawing buffer size. This avoids a black screen if onResize has not
    // been called yet.
    const size = new THREE.Vector2();
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

    // Update composite texel size so screen-space shadow offsets can be
    // expressed in pixels consistently.
    if (this.compositeMaterial && this.compositeMaterial.uniforms.uCompositeTexelSize) {
      this.compositeMaterial.uniforms.uCompositeTexelSize.value.set(1 / size.x, 1 / size.y);
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
    if (this.outdoorsScene && this.outdoorsMesh && this.outdoorsTarget) {
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
      renderer.render(this.lightScene, this.mainCamera);
    }

    // 2. Composite: use lightTarget as tLight and roofAlphaTarget as tRoofAlpha.
    // Base scene texture comes from EffectComposer via setInputTexture(tDiffuse).
    const cu = this.compositeMaterial.uniforms;
    cu.tLight.value = this.lightTarget.texture;
    cu.tRoofAlpha.value = this.roofAlphaTarget.texture;

    // Bind screen-space outdoors mask so we can avoid darkening
    // building interiors in a way that is correctly pinned to the
    // groundplane.
    cu.tOutdoorsMask.value = (this.outdoorsTarget && this.outdoorsTarget.texture)
      ? this.outdoorsTarget.texture
      : null;
    cu.uHasOutdoorsMask.value = this.outdoorsTarget ? 1.0 : 0.0;

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

    renderer.setRenderTarget(oldTarget);
    renderer.render(this.quadScene, this.quadCamera);
  }

  setInputTexture(texture) {
    if (this.compositeMaterial) {
      this.compositeMaterial.uniforms.tDiffuse.value = texture;
    }
  }
}