/**
 * @fileoverview Window Lighting & Shadows effect
 * Projects window light pools into interiors based on _Windows / _Structural masks.
 * Integrates with WeatherController cloud cover and supports RGB split and local CC.
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

    this.params = {
      // Status
      textureStatus: 'Searching...',
      hasWindowMask: false,

      // Core light controls
      intensity: 3.0,
      color: { r: 1.0, g: 0.96, b: 0.85 }, // Warm window light
      exposure: 0.0,
      brightness: 0.0,
      contrast: 1.0,
      saturation: 1.0,
      temperature: 0.0,
      tint: 0.0,

      // Mask shaping
      maskThreshold: 0.0,
      softness: 0.89,

      // Cloud interaction
      cloudInfluence: 1.0,   // 0=ignore clouds, 1=overcast kills light
      minCloudFactor: 0.0,   // Floor so light never fully disappears if desired

      // Specular coupling (local glints)
      specularBoost: 0.0,

      // Blending mode (0=Add, 1=Multiply, 2=Screen, 3=Overlay)
      blendMode: 3,

      // RGB Split
      rgbShiftAmount: 2.0,  // pixels at 1080p-ish; remapped in shader
      rgbShiftAngle: 125.0    // degrees
    };
  }

  get enabled() {
    return this._enabled;
  }

  set enabled(value) {
    this._enabled = value;
    if (this.mesh) this.mesh.visible = !!value;
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
          parameters: ['intensity', 'maskThreshold', 'softness']
        },
        {
          name: 'color',
          label: 'Color & CC',
          type: 'folder',
          parameters: ['color', 'exposure', 'brightness', 'contrast', 'saturation', 'temperature', 'tint']
        },
        {
          name: 'clouds',
          label: 'Cloud & Environment',
          type: 'inline',
          parameters: ['cloudInfluence', 'minCloudFactor']
        },
        {
          name: 'specular',
          label: 'Specular & Glints',
          type: 'inline',
          parameters: ['specularBoost']
        },
        {
          name: 'blending',
          label: 'Blending',
          type: 'inline',
          parameters: ['blendMode']
        },
        {
          name: 'rgb',
          label: 'RGB Split',
          type: 'inline',
          parameters: ['rgbShiftAmount', 'rgbShiftAngle']
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
          max: 5.0,
          step: 0.05,
          default: 3.0
        },
        maskThreshold: {
          type: 'slider',
          label: 'Mask Threshold',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.0
        },
        softness: {
          type: 'slider',
          label: 'Edge Softness',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 0.89
        },
        color: {
          type: 'color',
          label: 'Light Color',
          default: { r: 1.0, g: 0.96, b: 0.85 }
        },
        exposure: {
          type: 'slider',
          label: 'Exposure',
          min: -2.0,
          max: 2.0,
          step: 0.01,
          default: 0.0
        },
        brightness: {
          type: 'slider',
          label: 'Brightness',
          min: -0.5,
          max: 0.5,
          step: 0.01,
          default: 0.0
        },
        contrast: {
          type: 'slider',
          label: 'Contrast',
          min: 0.5,
          max: 2.0,
          step: 0.01,
          default: 1.0
        },
        saturation: {
          type: 'slider',
          label: 'Saturation',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 1.0
        },
        temperature: {
          type: 'slider',
          label: 'Temperature',
          min: -1.0,
          max: 1.0,
          step: 0.01,
          default: 0.0
        },
        tint: {
          type: 'slider',
          label: 'Tint',
          min: -1.0,
          max: 1.0,
          step: 0.01,
          default: 0.0
        },
        cloudInfluence: {
          type: 'slider',
          label: 'Cloud Influence',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 1.0
        },
        minCloudFactor: {
          type: 'slider',
          label: 'Min Cloud Factor',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.0
        },
        specularBoost: {
          type: 'slider',
          label: 'Specular Boost',
          min: 0.0,
          max: 3.0,
          step: 0.01,
          default: 0.0
        },
        blendMode: {
          type: 'list',
          label: 'Blend Mode',
          options: {
            Add: 0,
            Multiply: 1,
            Screen: 2,
            Overlay: 3
          },
          default: 3
        },
        rgbShiftAmount: {
          type: 'slider',
          label: 'RGB Shift',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 2.0
        },
        rgbShiftAngle: {
          type: 'slider',
          label: 'RGB Angle',
          min: 0.0,
          max: 360.0,
          step: 1.0,
          default: 125.0
        }
      }
    };
  }

  /**
   * Initialize effect
   */
  initialize(renderer, scene, camera) {
    this.scene = scene;
    log.info('Initializing WindowLightEffect');
  }

  /**
   * Set the base mesh and load assets
   * @param {THREE.Mesh} baseMesh
   * @param {MapAssetBundle} assetBundle
   */
  setBaseMesh(baseMesh, assetBundle) {
    this.baseMesh = baseMesh;

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
    log.info('Window mask loaded (driving LightingEffect window pools)');
  }

  createOverlayMesh() {
    const THREE = window.THREE;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uBaseMap: { value: (this.baseMesh && this.baseMesh.material && this.baseMesh.material.map) || null },
        uWindowMask: { value: this.windowMask },
        uOutdoorsMask: { value: this.outdoorsMask },
        uSpecularMask: { value: this.specularMask },

        uBlendMode: { value: this.params.blendMode },

        // Approximate texel size for the window mask so we can do a tiny
        // blur in the shader to soften hard pixel edges when the mask is
        // magnified.
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
        uMaskThreshold: { value: this.params.maskThreshold },
        uSoftness: { value: this.params.softness },

        uColor: { value: new THREE.Color(this.params.color.r, this.params.color.g, this.params.color.b) },
        uExposure: { value: this.params.exposure },
        uBrightness: { value: this.params.brightness },
        uContrast: { value: this.params.contrast },
        uSaturation: { value: this.params.saturation },
        uTemperature: { value: this.params.temperature },
        uTint: { value: this.params.tint },

        uCloudCover: { value: 0.0 },
        uCloudInfluence: { value: this.params.cloudInfluence },
        uMinCloudFactor: { value: this.params.minCloudFactor },

        uSpecularBoost: { value: this.params.specularBoost },

        uRgbShiftAmount: { value: this.params.rgbShiftAmount },
        uRgbShiftAngle: { value: this.params.rgbShiftAngle * (Math.PI / 180.0) }
      },
      vertexShader: this.getVertexShader(),
      fragmentShader: this.getFragmentShader(),
      side: THREE.DoubleSide,
      transparent: true,
      // Use normal blending and let the shader perform an overlay/screen style
      // mix with the underlying base map so the light feels painted onto the
      // groundplane instead of a white decal floating above it.
      blending: THREE.NormalBlending,
      depthWrite: false,
      depthTest: true
    });

    this.mesh = new THREE.Mesh(this.baseMesh.geometry, this.material);
    this.mesh.position.copy(this.baseMesh.position);
    this.mesh.rotation.copy(this.baseMesh.rotation);
    this.mesh.scale.copy(this.baseMesh.scale);

    // Overhead tiles use renderOrder=10; render this just beneath them so
    // roofs visually cover the window light pools when visible.
    this.mesh.renderOrder = 9;

    this.scene.add(this.mesh);
    this.mesh.visible = this._enabled;
  }

  getVertexShader() {
    return `
      varying vec2 vUv;

      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
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

      uniform int uBlendMode;

      uniform float uHasOutdoorsMask;
      uniform float uHasSpecularMask;

      uniform float uTime;
      uniform vec2 uResolution;

      uniform float uIntensity;
      uniform float uMaskThreshold;
      uniform float uSoftness;

      uniform vec3 uColor;
      uniform float uExposure;
      uniform float uBrightness;
      uniform float uContrast;
      uniform float uSaturation;
      uniform float uTemperature;
      uniform float uTint;

      uniform float uCloudCover;
      uniform float uCloudInfluence;
      uniform float uMinCloudFactor;

      uniform float uSpecularBoost;

      uniform float uRgbShiftAmount;
      uniform float uRgbShiftAngle;

      varying vec2 vUv;

      float msLuminance(vec3 c) {
        return dot(c, vec3(0.2126, 0.7152, 0.0722));
      }

      vec3 applyCC(vec3 color) {
        // Exposure
        color *= pow(2.0, uExposure);

        // Simple temperature/tint shift in YCbCr-ish space
        float t = uTemperature;
        float g = uTint;
        color.r += t * 0.1;
        color.b -= t * 0.1;
        color.g += g * 0.1;

        // Brightness
        color += vec3(uBrightness);

        // Contrast around mid-gray
        color = (color - 0.5) * uContrast + 0.5;

        // Saturation
        float l = msLuminance(color);
        color = mix(vec3(l), color, uSaturation);

        // Clamp to avoid negative values that can create dark artifacts in
        // additive/screen-style blends.
        return max(color, vec3(0.0));
      }

      vec3 blendColors(vec3 base, vec3 blend, int mode) {
        if (mode == 0) {
          // Add
          return base + blend;
        } else if (mode == 1) {
          // Multiply
          return base * blend;
        } else if (mode == 2) {
          // Screen
          return 1.0 - (1.0 - base) * (1.0 - blend);
        } else if (mode == 3) {
          // Overlay (per-channel)
          vec3 r;
          r.x = base.x < 0.5 ? (2.0 * base.x * blend.x) : (1.0 - 2.0 * (1.0 - base.x) * (1.0 - blend.x));
          r.y = base.y < 0.5 ? (2.0 * base.y * blend.y) : (1.0 - 2.0 * (1.0 - base.y) * (1.0 - blend.y));
          r.z = base.z < 0.5 ? (2.0 * base.z * blend.z) : (1.0 - 2.0 * (1.0 - base.z) * (1.0 - blend.z));
          return r;
        }
        // Fallback to additive
        return base + blend;
      }

      void main() {
        // Sample underlying battlemap colour so we can blend light into it
        vec3 baseColor = texture2D(uBaseMap, vUv).rgb;

        // If the effect intensity is effectively zero, behave as a no-op so
        // the window layer never darkens or distorts the base map.
        if (uIntensity <= 0.0001) {
          gl_FragColor = vec4(baseColor, 1.0);
          return;
        }

        // Base window mask sample (luminance mask with colour). For shaping,
        // we use a tiny 5-tap blur to avoid crunchy edges when the mask is
        // magnified.
        vec3 windowSample = texture2D(uWindowMask, vUv).rgb;
        float centerMask = msLuminance(windowSample);

        vec2 t = uWindowTexelSize;
        float maskN = msLuminance(texture2D(uWindowMask, vUv + vec2(0.0, -t.y)).rgb);
        float maskS = msLuminance(texture2D(uWindowMask, vUv + vec2(0.0,  t.y)).rgb);
        float maskE = msLuminance(texture2D(uWindowMask, vUv + vec2( t.x, 0.0)).rgb);
        float maskW = msLuminance(texture2D(uWindowMask, vUv + vec2(-t.x, 0.0)).rgb);

        float baseMask = (centerMask * 2.0 + maskN + maskS + maskE + maskW) / 6.0;

        // Mask shaping
        // Treat softness as a half-width around maskThreshold so we always
        // get a controllable falloff band instead of a hard clip when the
        // threshold is raised.
        float halfWidth = max(uSoftness, 1e-3);
        float edgeLo = clamp(uMaskThreshold - halfWidth, 0.0, 1.0);
        float edgeHi = clamp(uMaskThreshold + halfWidth, 0.0, 1.0);
        float m = smoothstep(edgeLo, edgeHi, baseMask);
        if (m <= 0.0) discard;

        // Outdoors rejection using _Outdoors mask
        float indoorFactor = 1.0;
        if (uHasOutdoorsMask > 0.5) {
          float outdoorStrength = texture2D(uOutdoorsMask, vUv).r;
          indoorFactor = 1.0 - outdoorStrength;
          if (indoorFactor <= 0.0) discard;
        }

        // Cloud attenuation from WeatherController cloudCover
        float cloud = clamp(uCloudCover, 0.0, 1.0);
        float cloudFactor = 1.0 - (cloud * 0.8 * uCloudInfluence);
        cloudFactor = max(cloudFactor, uMinCloudFactor);

        float windowStrength = m * indoorFactor * cloudFactor;
        
        // Treat the window mask primarily as a *brightness* mask for the
        // underlying groundplane. We derive a scalar light term from the
        // shaped mask and modulate the existing baseColor instead of
        // painting a separate opaque blob.

        // Scalar light factor (how much extra illumination we add).
        float lightScalar = windowStrength * uIntensity;

        // Warm tint for the additional light; we blend between neutral white
        // and user tint so the effect still feels like light on the floor
        // rather than a flat-coloured decal.
        vec3 tint = mix(vec3(1.0), uColor, 0.5);

        // Diffuse contribution: brighten the existing ground texture using
        // the mask-driven scalar and warm tint.
        vec3 diffuse = baseColor * tint * lightScalar;

        // Specular glint driven by _Specular mask
        vec3 specular = vec3(0.0);
        if (uSpecularBoost > 0.0 && uHasSpecularMask > 0.5) {
          float floorSpecular = texture2D(uSpecularMask, vUv).r;
          specular = vec3(1.0) * floorSpecular * windowStrength * uIntensity * uSpecularBoost;
        }

        vec3 lightColor = diffuse + specular;

        // Apply local CC to the light contribution only
        lightColor = applyCC(lightColor);

        // Treat window light as additive illumination on the groundplane.
        // We keep the light contribution non-negative so it can only
        // brighten the underlying map, never darken it.
        vec3 finalColor = baseColor + clamp(lightColor, 0.0, 10.0);

        gl_FragColor = vec4(finalColor, 1.0);
      }
    `;
  }

  update(timeInfo) {
    if (!this.material || !this.mesh) return;

    this.mesh.visible = this._enabled && this.params.hasWindowMask;
    if (!this.mesh.visible) return;

    this.material.uniforms.uTime.value = timeInfo.elapsed;

    // Sync weather cloud cover
    try {
      const state = weatherController?.getCurrentState?.();
      if (state && typeof state.cloudCover === 'number') {
        this.material.uniforms.uCloudCover.value = state.cloudCover;
      }
    } catch (e) {
      // ignore
    }

    // Sync params
    const u = this.material.uniforms;
    u.uIntensity.value = this.params.intensity;
    u.uMaskThreshold.value = this.params.maskThreshold;
    u.uSoftness.value = this.params.softness;

    u.uColor.value.set(this.params.color.r, this.params.color.g, this.params.color.b);
    u.uExposure.value = this.params.exposure;
    u.uBrightness.value = this.params.brightness;
    u.uContrast.value = this.params.contrast;
    u.uSaturation.value = this.params.saturation;
    u.uTemperature.value = this.params.temperature;
    u.uTint.value = this.params.tint;

    u.uCloudInfluence.value = this.params.cloudInfluence;
    u.uMinCloudFactor.value = this.params.minCloudFactor;

    u.uSpecularBoost.value = this.params.specularBoost;

    u.uBlendMode.value = this.params.blendMode;

    u.uRgbShiftAmount.value = this.params.rgbShiftAmount;
    u.uRgbShiftAngle.value = this.params.rgbShiftAngle * (Math.PI / 180.0);
  }

  onResize(width, height) {
    if (this.material) {
      this.material.uniforms.uResolution.value.set(width, height);
    }
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
    this.windowMask = null;
    this.outdoorsMask = null;
    this.specularMask = null;
    log.info('WindowLightEffect disposed');
  }
}
