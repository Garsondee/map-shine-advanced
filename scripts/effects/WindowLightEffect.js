/**
 * @fileoverview Window Lighting & Shadows effect
 * Projects window light pools into interiors based on _Windows / _Structural masks.
 * Redesigned for reliability and softer, more natural light falloff.
 * @module effects/WindowLightEffect
 */

import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { weatherController } from '../core/WeatherController.js';

const log = createLogger('WindowLightEffect');

export class WindowLightEffect extends EffectBase {
  constructor() {
    super('windowLight', RenderLayers.SURFACE_EFFECTS, 'low');

    this.priority = 12; // After base material, alongside other surface overlays
    this.alwaysRender = false;

    this._enabled = true;

    /** @type {THREE.Mesh|null} */
    this.mesh = null;
    /** @type {THREE.Mesh|null} */
    this.baseMesh = null;

    /** @type {THREE.Texture|null} */
    this.windowMask = null;      // _Windows / _Structural
    /** @type {THREE.Texture|null} */
    this.outdoorsMask = null;    // _Outdoors
    /** @type {THREE.Texture|null} */
    this.specularMask = null;    // _Specular (optional)

    /** @type {THREE.ShaderMaterial|null} */
    this.material = null;

    this._bundleBaseTexture = null;

    /** @type {THREE.WebGLRenderTarget|null} */
    this.lightTarget = null; // Render target for window light brightness (used by TileManager)

    /** @type {THREE.Scene|null} */
    this.lightScene = null; // Separate scene for rendering light-only pass

    /** @type {THREE.Mesh|null} */
    this.lightMesh = null; // Mesh for light-only rendering

    /** @type {THREE.ShaderMaterial|null} */
    this.lightMaterial = null; // Material for light-only pass

    this._publishedWindowLightTex = null;

    this.params = {
      // Status
      textureStatus: 'Searching...',
      hasWindowMask: false,

      // Core light controls
      intensity: 10.0,
      color: { r: 1.0, g: 0.96, b: 0.85 }, // Warm window light
      
      // Mask shaping (Gamma/Gain model)
      falloff: 2.2, // Gamma power for falloff shaping

      // Environment
      cloudInfluence: 0.8,     // How much clouds dim the light (0-1)
      nightDimming: 0.8,       // How much night dims the light (0-1)

      // Cloud shadow shaping (applied to cloudShadowRaw.screen before influence/cover mix)
      cloudShadowContrast: 1.2,
      cloudShadowBias: 0.0,
      cloudShadowGamma: 1.0,
      cloudShadowMinLight: 0.0,

      // Specular coupling
      specularBoost: 3.0,

      // RGB Split (Refraction)
      rgbShiftAmount: 5.0,  // pixels
      rgbShiftAngle: 158.0, // degrees

      // Overhead tile lighting
      lightOverheadTiles: true,
      overheadLightIntensity: 0.2
    };
  }

  _applyThreeColor(target, input) {
    const THREE = window.THREE;
    if (!THREE || !target) return;
    if (input && typeof input === 'object' && 'r' in input && 'g' in input && 'b' in input) {
      target.set(input.r, input.g, input.b);
      return;
    }
    if (typeof input === 'string' || typeof input === 'number') {
      target.set(input);
      return;
    }
    target.set(1.0, 1.0, 1.0);
  }

  get enabled() {
    return this._enabled;
  }

  set enabled(value) {
    const next = !!value;
    this._enabled = next;
    if (this.mesh) this.mesh.visible = next;

    // Ensure downstream systems cannot keep using a stale light texture.
    if (!next) {
      try {
        const mm = window.MapShine?.maskManager;
        if (mm && typeof mm.setTexture === 'function') {
          mm.setTexture('windowLight.screen', null);
        }
        this._publishedWindowLightTex = null;
      } catch (e) {
      }
    }
  }

  /**
   * UI schema for Tweakpane
   */
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'status',
          label: 'Effect Status',
          type: 'inline',
          parameters: ['textureStatus']
        },
        {
          name: 'lighting',
          label: 'Window Light',
          type: 'inline',
          parameters: ['intensity', 'falloff', 'color']
        },
        {
          name: 'environment',
          label: 'Environment',
          type: 'inline',
          parameters: ['cloudInfluence', 'nightDimming']
        },
        {
          name: 'cloudShadows',
          label: 'Cloud Shadows',
          type: 'inline',
          parameters: ['cloudShadowContrast', 'cloudShadowBias', 'cloudShadowGamma', 'cloudShadowMinLight']
        },
        {
          name: 'refraction',
          label: 'Refraction (RGB)',
          type: 'inline',
          parameters: ['rgbShiftAmount', 'rgbShiftAngle']
        },
        {
          name: 'advanced',
          label: 'Advanced',
          type: 'folder',
          parameters: ['specularBoost', 'lightOverheadTiles', 'overheadLightIntensity']
        }
      ],
      parameters: {
        hasWindowMask: {
          type: 'boolean',
          default: false,
          hidden: true
        },
        textureStatus: {
          type: 'string',
          label: 'Mask Status',
          default: 'Checking...',
          readonly: true
        },
        intensity: {
          type: 'slider',
          label: 'Intensity',
          min: 0.0,
          max: 25.0,
          step: 0.1,
          default: 10.0
        },
        falloff: {
          type: 'slider',
          label: 'Falloff (Gamma)',
          min: 0.1,
          max: 5.0,
          step: 0.1,
          default: 2.2
        },
        color: {
          type: 'color',
          label: 'Light Color',
          default: { r: 1.0, g: 0.96, b: 0.85 }
        },
        cloudInfluence: {
          type: 'slider',
          label: 'Cloud Dimming',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.8
        },
        nightDimming: {
          type: 'slider',
          label: 'Night Dimming',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.8
        },
        cloudShadowContrast: {
          type: 'slider',
          label: 'Shadow Contrast',
          min: 0.0,
          max: 4.0,
          step: 0.01,
          default: 1.2
        },
        cloudShadowBias: {
          type: 'slider',
          label: 'Shadow Bias',
          min: -1.0,
          max: 1.0,
          step: 0.01,
          default: 0.0
        },
        cloudShadowGamma: {
          type: 'slider',
          label: 'Shadow Gamma',
          min: 0.1,
          max: 4.0,
          step: 0.01,
          default: 1.0
        },
        cloudShadowMinLight: {
          type: 'slider',
          label: 'Min Light',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.0
        },
        rgbShiftAmount: {
          type: 'slider',
          label: 'RGB Shift',
          min: 0.0,
          max: 20.0,
          step: 0.1,
          default: 5.0
        },
        rgbShiftAngle: {
          type: 'slider',
          label: 'RGB Angle',
          min: 0.0,
          max: 360.0,
          step: 1.0,
          default: 158.0
        },
        specularBoost: {
          type: 'slider',
          label: 'Specular Boost',
          min: 0.0,
          max: 5.0,
          step: 0.1,
          default: 3.0
        },
        lightOverheadTiles: {
          type: 'boolean',
          label: 'Light Overheads',
          default: true
        },
        overheadLightIntensity: {
          type: 'slider',
          label: 'Overhead Intensity',
          min: 0.0,
          max: 1.0,
          step: 0.05,
          default: 0.2
        }
      }
    };
  }

  /**
   * Initialize effect
   */
  initialize(renderer, scene, camera) {
    this.scene = scene;
    this.renderer = renderer;
    this.camera = camera;
    log.info('Initializing WindowLightEffect (Redesigned)');
  }

  /**
   * Set the base mesh and load assets
   * @param {THREE.Mesh} baseMesh
   * @param {MapAssetBundle} assetBundle
   */
  setBaseMesh(baseMesh, assetBundle) {
    this.baseMesh = baseMesh;

    this._bundleBaseTexture = assetBundle?.baseTexture || null;

    const windowData = assetBundle.masks.find(m => m.id === 'windows' || m.id === 'structural');
    const outdoorsData = assetBundle.masks.find(m => m.id === 'outdoors');
    const specularData = assetBundle.masks.find(m => m.id === 'specular');

    this.windowMask = windowData?.texture || null;
    this.outdoorsMask = outdoorsData?.texture || null;
    this.specularMask = specularData?.texture || null;

    this.params.hasWindowMask = !!this.windowMask;

    if (!this.windowMask) {
      this.params.textureStatus = 'Inactive (No _Windows / _Structural mask found)';
      log.info('No window/structural mask found, WindowLightEffect disabled');
      this.enabled = false;
      return;
    }

    this.params.textureStatus = 'Ready (Texture Found)';
    log.info('Window mask loaded');
  }

  createOverlayMesh() {
    const THREE = window.THREE;

    const baseMaterial = this.baseMesh?.material;
    const baseMap =
      baseMaterial?.map ||
      baseMaterial?.uniforms?.uAlbedoMap?.value ||
      this._bundleBaseTexture ||
      null;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uBaseMap: { value: baseMap },
        uWindowMask: { value: this.windowMask },
        uOutdoorsMask: { value: this.outdoorsMask },
        uSpecularMask: { value: this.specularMask },

        uWindowTexelSize: {
          value: this.windowMask && this.windowMask.image
            ? new THREE.Vector2(1 / this.windowMask.image.width, 1 / this.windowMask.image.height)
            : new THREE.Vector2(1 / 1024, 1 / 1024)
        },

        uHasOutdoorsMask: { value: this.outdoorsMask ? 1.0 : 0.0 },
        uHasSpecularMask: { value: this.specularMask ? 1.0 : 0.0 },

        uTime: { value: 0.0 },
        uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },

        uIntensity: { value: this.params.intensity },
        uFalloff: { value: this.params.falloff },
        uColor: { value: new THREE.Color(this.params.color.r, this.params.color.g, this.params.color.b) },

        uCloudCover: { value: 0.0 },
        uCloudInfluence: { value: this.params.cloudInfluence },
        uDarknessLevel: { value: 0.0 },
        uNightDimming: { value: this.params.nightDimming },

        uCloudShadowContrast: { value: this.params.cloudShadowContrast },
        uCloudShadowBias: { value: this.params.cloudShadowBias },
        uCloudShadowGamma: { value: this.params.cloudShadowGamma },
        uCloudShadowMinLight: { value: this.params.cloudShadowMinLight },

        uCloudShadowMap: { value: null },
        uHasCloudShadowMap: { value: 0.0 },

        uSpecularBoost: { value: this.params.specularBoost },

        uRgbShiftAmount: { value: this.params.rgbShiftAmount },
        uRgbShiftAngle: { value: this.params.rgbShiftAngle * (Math.PI / 180.0) }
      },
      vertexShader: this.getVertexShader(),
      fragmentShader: this.getFragmentShader(),
      side: THREE.DoubleSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true
    });

    this.mesh = new THREE.Mesh(this.baseMesh.geometry, this.material);
    this.mesh.position.copy(this.baseMesh.position);
    this.mesh.rotation.copy(this.baseMesh.rotation);
    this.mesh.scale.copy(this.baseMesh.scale);

    this.mesh.renderOrder = 9; // Just below Overhead Tiles (10)

    this.scene.add(this.mesh);
    this.mesh.visible = this._enabled;
  }

  getVertexShader() {
    return `
      varying vec2 vUv;
      varying vec4 vClipPos;

      void main() {
        vUv = uv;
        vClipPos = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = vClipPos;
      }
    `;
  }

  getFragmentShader() {
    return `
      uniform sampler2D uBaseMap;
      uniform sampler2D uWindowMask;
      uniform sampler2D uOutdoorsMask;
      uniform sampler2D uSpecularMask;

      uniform vec2 uWindowTexelSize;

      uniform float uHasOutdoorsMask;
      uniform float uHasSpecularMask;

      uniform float uIntensity;
      uniform float uFalloff;
      uniform vec3 uColor;

      uniform float uCloudCover;
      uniform float uCloudInfluence;
      uniform float uDarknessLevel;
      uniform float uNightDimming;

      uniform float uCloudShadowContrast;
      uniform float uCloudShadowBias;
      uniform float uCloudShadowGamma;
      uniform float uCloudShadowMinLight;

      uniform sampler2D uCloudShadowMap;
      uniform float uHasCloudShadowMap;

      uniform float uSpecularBoost;

      uniform float uRgbShiftAmount;
      uniform float uRgbShiftAngle;

      varying vec4 vClipPos;
      varying vec2 vUv;

      float msLuminance(vec3 c) {
        return dot(c, vec3(0.2126, 0.7152, 0.0722));
      }

      void main() {
        if (uIntensity <= 0.001) {
          gl_FragColor = vec4(0.0);
          return;
        }

        // 1. Refraction / RGB Shift
        // Sample mask 3 times with offsets
        vec2 shiftDir = vec2(cos(uRgbShiftAngle), sin(uRgbShiftAngle));
        vec2 rOffset = shiftDir * uRgbShiftAmount * uWindowTexelSize;
        vec2 bOffset = -rOffset;

        float r = msLuminance(texture2D(uWindowMask, vUv + rOffset).rgb);
        float g = msLuminance(texture2D(uWindowMask, vUv).rgb);
        float b = msLuminance(texture2D(uWindowMask, vUv + bOffset).rgb);
        
        vec3 maskSample = vec3(r, g, b);

        // 2. Shape Falloff (Gamma)
        // Helps control the "spread" of the light without hard clipping
        vec3 lightMap = pow(max(maskSample, vec3(0.0)), vec3(uFalloff));

        // 3. Outdoors Rejection (Soft)
        // If outdoors, we shouldn't see window light (unless it's a skylight, but usually this is for interiors)
        float indoorFactor = 1.0;
        if (uHasOutdoorsMask > 0.5) {
          float outdoorStrength = texture2D(uOutdoorsMask, vUv).r;
          indoorFactor = clamp(1.0 - outdoorStrength, 0.0, 1.0);
        }

        // 4. Environmental Attenuation
        float envFactor = 1.0;

        // Cloud Shadow (Screen Space)
        if (uHasCloudShadowMap > 0.5) {
          vec2 screenUV = (vClipPos.xy / vClipPos.w) * 0.5 + 0.5;
          float cloudLightFactor = clamp(texture2D(uCloudShadowMap, screenUV).r, 0.0, 1.0);

          cloudLightFactor = clamp(cloudLightFactor + uCloudShadowBias, 0.0, 1.0);
          cloudLightFactor = pow(cloudLightFactor, max(uCloudShadowGamma, 0.0001));
          cloudLightFactor = clamp((cloudLightFactor - 0.5) * uCloudShadowContrast + 0.5, 0.0, 1.0);
          cloudLightFactor = max(cloudLightFactor, clamp(uCloudShadowMinLight, 0.0, 1.0));

          // Treat cloud cover as an overall strength multiplier, but keep the
          // spatial modulation coming from the texture.
          float k = clamp(uCloudInfluence * clamp(uCloudCover, 0.0, 1.0), 0.0, 1.0);
          envFactor *= mix(1.0, cloudLightFactor, k);
        }

        // Night Dimming
        float nightFactor = uDarknessLevel * uNightDimming;
        envFactor *= (1.0 - clamp(nightFactor, 0.0, 1.0));

        // 5. Final Light Composition
        vec3 finalLight = lightMap * uColor * uIntensity * indoorFactor * envFactor;

        // 6. Specular Glint
        if (uSpecularBoost > 0.0 && uHasSpecularMask > 0.5) {
            float spec = texture2D(uSpecularMask, vUv).r;
            finalLight += finalLight * spec * uSpecularBoost;
        }

        // Additive overlay: output ONLY the light contribution.
        gl_FragColor = vec4(finalLight, 1.0);
      }
    `;
  }

  update(timeInfo) {
    if (!this.material || !this.mesh) return;

    this.mesh.visible = this._enabled && this.params.hasWindowMask;
    if (!this.mesh.visible) return;

    this.material.uniforms.uTime.value = timeInfo.elapsed;

    // Sync environment
    let cloudCover = 0.0;
    try {
        const wcDisabled = (weatherController && weatherController.enabled === false && weatherController.dynamicEnabled !== true);
        if (!wcDisabled && weatherController?.getCurrentState) {
            const state = weatherController.getCurrentState();
            if (state && typeof state.cloudCover === 'number') cloudCover = state.cloudCover;
        } else {
            const cloudEffect = window.MapShine?.cloudEffect;
            if (cloudEffect?.params?.cloudCover !== undefined) cloudCover = cloudEffect.params.cloudCover;
        }
    } catch(e) {}
    this.material.uniforms.uCloudCover.value = Math.max(0.0, Math.min(1.0, cloudCover));
    if (this.lightMaterial?.uniforms?.uCloudCover) {
      this.lightMaterial.uniforms.uCloudCover.value = this.material.uniforms.uCloudCover.value;
    }

    let darkness = 0.0;
    try {
        if (typeof canvas?.environment?.darknessLevel === 'number') darkness = canvas.environment.darknessLevel;
        else if (typeof canvas?.scene?.environment?.darknessLevel === 'number') darkness = canvas.scene.environment.darknessLevel;
    } catch(e) {}
    this.material.uniforms.uDarknessLevel.value = Math.max(0.0, Math.min(1.0, darkness));
    if (this.lightMaterial?.uniforms?.uDarknessLevel) {
      this.lightMaterial.uniforms.uDarknessLevel.value = this.material.uniforms.uDarknessLevel.value;
    }

    // Cloud Shadows
    try {
        const mm = window.MapShine?.maskManager;
        const mmCloud = mm ? mm.getTexture('cloudShadowRaw.screen') : null;
        const bindCloudShadow = (mat, tex) => {
          if (!mat?.uniforms) return;
          if (tex) {
            mat.uniforms.uCloudShadowMap.value = tex;
            mat.uniforms.uHasCloudShadowMap.value = 1.0;
          } else {
            mat.uniforms.uCloudShadowMap.value = null;
            mat.uniforms.uHasCloudShadowMap.value = 0.0;
          }
        };

        if (mmCloud) {
          bindCloudShadow(this.material, mmCloud);
          bindCloudShadow(this.lightMaterial, mmCloud);
        } else {
          const cloudEffect = window.MapShine?.cloudEffect;
          const tex = (cloudEffect?.cloudShadowRawTarget?.texture && cloudEffect.enabled)
            ? cloudEffect.cloudShadowRawTarget.texture
            : null;
          bindCloudShadow(this.material, tex);
          bindCloudShadow(this.lightMaterial, tex);
        }
    } catch (e) {
        this.material.uniforms.uHasCloudShadowMap.value = 0.0;
        if (this.lightMaterial?.uniforms?.uHasCloudShadowMap) {
          this.lightMaterial.uniforms.uHasCloudShadowMap.value = 0.0;
        }
    }

    // Update Params
    const u = this.material.uniforms;
    u.uIntensity.value = this.params.intensity;
    u.uFalloff.value = this.params.falloff;
    this._applyThreeColor(u.uColor.value, this.params.color);
    u.uCloudInfluence.value = this.params.cloudInfluence;
    u.uNightDimming.value = this.params.nightDimming;
    u.uCloudShadowContrast.value = this.params.cloudShadowContrast;
    u.uCloudShadowBias.value = this.params.cloudShadowBias;
    u.uCloudShadowGamma.value = this.params.cloudShadowGamma;
    u.uCloudShadowMinLight.value = this.params.cloudShadowMinLight;
    u.uSpecularBoost.value = this.params.specularBoost;
    u.uRgbShiftAmount.value = this.params.rgbShiftAmount;
    u.uRgbShiftAngle.value = this.params.rgbShiftAngle * (Math.PI / 180.0);

    if (this.lightMaterial?.uniforms) {
      const lu = this.lightMaterial.uniforms;
      lu.uIntensity.value = this.params.intensity;
      lu.uFalloff.value = this.params.falloff;
      this._applyThreeColor(lu.uColor.value, this.params.color);
      lu.uCloudInfluence.value = this.params.cloudInfluence;
      lu.uNightDimming.value = this.params.nightDimming;
      lu.uCloudShadowContrast.value = this.params.cloudShadowContrast;
      lu.uCloudShadowBias.value = this.params.cloudShadowBias;
      lu.uCloudShadowGamma.value = this.params.cloudShadowGamma;
      lu.uCloudShadowMinLight.value = this.params.cloudShadowMinLight;
    }
  }

  onResize(width, height) {
    const THREE = window.THREE;
    let w = width;
    let h = height;
    try {
      if (THREE && this.renderer && typeof this.renderer.getDrawingBufferSize === 'function') {
        if (!this._tmpDrawSize) this._tmpDrawSize = new THREE.Vector2();
        this.renderer.getDrawingBufferSize(this._tmpDrawSize);
        w = Math.max(1, Math.floor(this._tmpDrawSize.x || w));
        h = Math.max(1, Math.floor(this._tmpDrawSize.y || h));
      }
    } catch (e) {}

    if (this.material) this.material.uniforms.uResolution.value.set(w, h);
    if (this.lightMaterial) this.lightMaterial.uniforms.uResolution.value.set(w, h);
    if (this.lightTarget) this.lightTarget.setSize(w, h);
  }

  createLightTarget() {
    const THREE = window.THREE;
    if (!THREE || !this.baseMesh || !this.windowMask) return;

    // Use current resolution
    let width = window.innerWidth;
    let height = window.innerHeight;
    try {
        if (this.renderer) {
            const size = new THREE.Vector2();
            this.renderer.getDrawingBufferSize(size);
            width = size.x;
            height = size.y;
        }
    } catch(e) {}

    this.lightTarget = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType
    });

    this.lightScene = new THREE.Scene();

    this.lightMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uWindowMask: { value: this.windowMask },
        uOutdoorsMask: { value: this.outdoorsMask },
        uWindowTexelSize: {
          value: this.windowMask && this.windowMask.image
            ? new THREE.Vector2(1 / this.windowMask.image.width, 1 / this.windowMask.image.height)
            : new THREE.Vector2(1 / 1024, 1 / 1024)
        },
        uHasOutdoorsMask: { value: this.outdoorsMask ? 1.0 : 0.0 },

        uIntensity: { value: this.params.intensity },
        uFalloff: { value: this.params.falloff },
        uColor: { value: new THREE.Color(this.params.color.r, this.params.color.g, this.params.color.b) },

        uCloudCover: { value: 0.0 },
        uCloudInfluence: { value: this.params.cloudInfluence },
        uDarknessLevel: { value: 0.0 },
        uNightDimming: { value: this.params.nightDimming },

        uCloudShadowContrast: { value: this.params.cloudShadowContrast },
        uCloudShadowBias: { value: this.params.cloudShadowBias },
        uCloudShadowGamma: { value: this.params.cloudShadowGamma },
        uCloudShadowMinLight: { value: this.params.cloudShadowMinLight },

        uCloudShadowMap: { value: null },
        uHasCloudShadowMap: { value: 0.0 }
      },
      vertexShader: this.getVertexShader(),
      fragmentShader: this.getLightOnlyFragmentShader(),
      side: THREE.DoubleSide,
      transparent: false,
      depthWrite: false,
      depthTest: false
    });

    this.lightMesh = new THREE.Mesh(this.baseMesh.geometry, this.lightMaterial);
    this.lightMesh.position.copy(this.baseMesh.position);
    this.lightMesh.rotation.copy(this.baseMesh.rotation);
    this.lightMesh.scale.copy(this.baseMesh.scale);

    this.lightScene.add(this.lightMesh);
    log.info('Window light target created for overhead tile lighting');
  }

  getLightOnlyFragmentShader() {
    return `
      uniform sampler2D uWindowMask;
      uniform sampler2D uOutdoorsMask;
      uniform float uHasOutdoorsMask;
      
      uniform float uIntensity;
      uniform float uFalloff;
      uniform vec3 uColor;

      uniform float uCloudCover;
      uniform float uCloudInfluence;
      uniform float uDarknessLevel;
      uniform float uNightDimming;

      uniform float uCloudShadowContrast;
      uniform float uCloudShadowBias;
      uniform float uCloudShadowGamma;
      uniform float uCloudShadowMinLight;

      uniform sampler2D uCloudShadowMap;
      uniform float uHasCloudShadowMap;

      varying vec4 vClipPos;
      varying vec2 vUv;

      float msLuminance(vec3 c) {
        return dot(c, vec3(0.2126, 0.7152, 0.0722));
      }

      void main() {
        vec3 maskSample = texture2D(uWindowMask, vUv).rgb;
        vec3 lightMap = pow(max(maskSample, vec3(0.0)), vec3(uFalloff));
        float brightness = msLuminance(lightMap);

        float indoorFactor = 1.0;
        if (uHasOutdoorsMask > 0.5) {
          float outdoorStrength = texture2D(uOutdoorsMask, vUv).r;
          indoorFactor = clamp(1.0 - outdoorStrength, 0.0, 1.0);
        }

        float envFactor = 1.0;
        if (uHasCloudShadowMap > 0.5) {
          vec2 screenUV = (vClipPos.xy / vClipPos.w) * 0.5 + 0.5;
          float cloudLightFactor = clamp(texture2D(uCloudShadowMap, screenUV).r, 0.0, 1.0);

          cloudLightFactor = clamp(cloudLightFactor + uCloudShadowBias, 0.0, 1.0);
          cloudLightFactor = pow(cloudLightFactor, max(uCloudShadowGamma, 0.0001));
          cloudLightFactor = clamp((cloudLightFactor - 0.5) * uCloudShadowContrast + 0.5, 0.0, 1.0);
          cloudLightFactor = max(cloudLightFactor, clamp(uCloudShadowMinLight, 0.0, 1.0));
          float k = clamp(uCloudInfluence * clamp(uCloudCover, 0.0, 1.0), 0.0, 1.0);
          envFactor *= mix(1.0, cloudLightFactor, k);
        }

        float nightFactor = uDarknessLevel * uNightDimming;
        envFactor *= (1.0 - clamp(nightFactor, 0.0, 1.0));

        float finalBrightness = brightness * uIntensity * indoorFactor * envFactor;
        
        // Output premultiplied color/brightness
        gl_FragColor = vec4(uColor * finalBrightness, finalBrightness);
      }
    `;
  }

  renderLightPass(renderer) {
    if (!this.lightTarget || !this.lightScene || !this.camera) return;
    if (!this._enabled || !this.params.hasWindowMask) return;

    // Uniforms are updated in update(), so we just render.

    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.lightTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(this.lightScene, this.camera);
    renderer.setRenderTarget(prevTarget);

    // Publish
    try {
      const mm = window.MapShine?.maskManager;
      if (mm) {
        const tex = this.lightTarget?.texture;
        if (tex && tex !== this._publishedWindowLightTex) {
          this._publishedWindowLightTex = tex;
          mm.setTexture('windowLight.screen', tex, {
            space: 'screenUv',
            source: 'renderTarget',
            channels: 'a',
            uvFlipY: false,
            lifecycle: 'dynamicPerFrame',
            width: this.lightTarget?.width ?? null,
            height: this.lightTarget?.height ?? null
          });
        }
      }
    } catch (e) {}
  }

  getLightTexture() {
    if (!this._enabled || !this.params.hasWindowMask) return null;
    return this.lightTarget?.texture || null;
  }

  dispose() {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh = null;
    }
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
    if (this.lightMesh && this.lightScene) {
      this.lightScene.remove(this.lightMesh);
      this.lightMesh = null;
    }
    if (this.lightMaterial) {
      this.lightMaterial.dispose();
      this.lightMaterial = null;
    }
    if (this.lightTarget) {
      this.lightTarget.dispose();
      this.lightTarget = null;
    }
    this.lightScene = null;
    this.windowMask = null;
    this.outdoorsMask = null;
    this.specularMask = null;
    log.info('WindowLightEffect disposed');
  }

  /**
   * Main render hook called by EffectComposer.
   * We use this to update the light-only render target used by overhead tiles.
   * The main visual effect is handled by the mesh in the scene.
   * @param {THREE.WebGLRenderer} renderer 
   */
  render(renderer) {
    this.renderLightPass(renderer);
  }
}
