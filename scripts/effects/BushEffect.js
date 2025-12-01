import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { weatherController } from '../core/WeatherController.js';

const log = createLogger('BushEffect');

/**
 * Animated Bushes effect
 * Renders the `_Bush` RGBA texture as a surface overlay on the base plane
 * and applies wind-driven UV distortion to simulate foliage motion.
 */
export class BushEffect extends EffectBase {
  constructor() {
    super('bush', RenderLayers.SURFACE_EFFECTS, 'low');

    this.priority = 11;
    this.alwaysRender = false;

    /** @type {THREE.Mesh|null} */
    this.baseMesh = null;
    /** @type {THREE.Mesh|null} */
    this.mesh = null;

    /** @type {THREE.Texture|null} */
    this.bushMask = null; // _Bush texture (RGBA with transparency)

    /** @type {THREE.ShaderMaterial|null} */
    this.material = null;

    /** @type {THREE.Scene|null} */
    this.scene = null;

    this._enabled = true;

    this.params = {
      enabled: true,
      intensity: 1.0,          // Overall contribution of the bush layer
      swayIntensity: 0.02,     // Low-frequency sway strength
      swayFrequency: 0.5,      // Low-frequency sway speed (Hz-ish)
      flutterIntensity: 0.005, // High-frequency flutter strength
      detailScale: 12.0,       // Spatial frequency of flutter noise

      // Local color correction for foliage (tuned defaults)
      exposure: -2.0,
      brightness: 0.0,
      contrast: 1.03,
      saturation: 1.25,
      temperature: 0.0,
      tint: 0.0
    };
  }

  get enabled() {
    return this._enabled;
  }

  set enabled(value) {
    this._enabled = !!value;
    if (this.mesh) this.mesh.visible = !!value && !!this.bushMask;
  }

  /**
   * UI control schema for Tweakpane
   */
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'bush-main',
          label: 'Animated Bushes',
          type: 'inline',
          parameters: ['intensity', 'swayIntensity', 'swayFrequency', 'flutterIntensity']
        },
        {
          name: 'bush-color',
          label: 'Color & CC',
          type: 'folder',
          parameters: ['exposure', 'brightness', 'contrast', 'saturation', 'temperature', 'tint']
        }
      ],
      parameters: {
        intensity: {
          type: 'slider',
          label: 'Opacity',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 1.0
        },
        swayIntensity: {
          type: 'slider',
          label: 'Sway Intensity',
          min: 0.0,
          max: 0.08,
          step: 0.001,
          default: 0.02
        },
        swayFrequency: {
          type: 'slider',
          label: 'Sway Speed',
          min: 0.1,
          max: 2.0,
          step: 0.01,
          default: 0.5
        },
        flutterIntensity: {
          type: 'slider',
          label: 'Flutter Intensity',
          min: 0.0,
          max: 0.02,
          step: 0.0005,
          default: 0.005
        },
        detailScale: {
          type: 'slider',
          label: 'Detail Scale',
          min: 4.0,
          max: 32.0,
          step: 0.5,
          default: 12.0
        },
        exposure: {
          type: 'slider',
          label: 'Exposure',
          min: -2.0,
          max: 2.0,
          step: 0.01,
          default: -2.0
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
          default: 1.03
        },
        saturation: {
          type: 'slider',
          label: 'Saturation',
          min: 0.0,
          max: 2.0,
          step: 0.01,
          default: 1.25
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
        }
      }
    };
  }

  initialize(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    log.info('BushEffect initialized');
  }

  /**
   * Receive base mesh and asset bundle so we can access the _Bush texture.
   * @param {THREE.Mesh} baseMesh
   * @param {MapAssetBundle} assetBundle
   */
  setBaseMesh(baseMesh, assetBundle) {
    if (!assetBundle || !assetBundle.masks) return;

    const THREE = window.THREE;
    if (!THREE) return;

    this.baseMesh = baseMesh;

    const bushData = assetBundle.masks.find(m => m.id === 'bush' || m.type === 'bush');
    this.bushMask = bushData?.texture || null;

    if (!this.bushMask) {
      log.info('No _Bush texture found for BushEffect; disabling effect');
      this.enabled = false;
      return;
    }

    if (this.scene) {
      this._createMesh();
    }
  }

  _createMesh() {
    const THREE = window.THREE;
    if (!THREE || !this.baseMesh || !this.bushMask) return;

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
        uBushMask: { value: this.bushMask },
        uTime: { value: 0.0 },
        uWindDir: { value: new THREE.Vector2(1.0, 0.0) },
        uWindSpeed: { value: 0.0 },
        uIntensity: { value: this.params.intensity },
        uSwayIntensity: { value: this.params.swayIntensity },
        uSwayFrequency: { value: this.params.swayFrequency },
        uFlutterIntensity: { value: this.params.flutterIntensity },
        uDetailScale: { value: this.params.detailScale },
        uExposure: { value: this.params.exposure },
        uBrightness: { value: this.params.brightness },
        uContrast: { value: this.params.contrast },
        uSaturation: { value: this.params.saturation },
        uTemperature: { value: this.params.temperature },
        uTint: { value: this.params.tint },
        tOverheadShadow: { value: null },
        tBuildingShadow: { value: null },
        tOutdoorsMask: { value: null },
        uOverheadShadowOpacity: { value: 0.0 },
        uBuildingShadowOpacity: { value: 0.0 },
        uHasOutdoorsMask: { value: 0.0 }
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec2 vScreenUv;

        void main() {
          vUv = uv;

          // Compute clip-space position
          vec4 clipPos = projectionMatrix * modelViewMatrix * vec4(position, 1.0);

          // Derive screen-space UV (0-1) from clip-space position so we can
          // sample screen-space shadow buffers that are aligned with the
          // camera, matching LightingEffect.
          vec2 ndc = clipPos.xy / clipPos.w;
          vScreenUv = ndc * 0.5 + 0.5;

          gl_Position = clipPos;
        }
      `,
      fragmentShader: `
        uniform sampler2D uBushMask;

        uniform float uTime;
        uniform vec2  uWindDir;
        uniform float uWindSpeed;
        uniform float uIntensity;
        uniform float uSwayIntensity;
        uniform float uSwayFrequency;
        uniform float uFlutterIntensity;
        uniform float uDetailScale;
        uniform float uExposure;
        uniform float uBrightness;
        uniform float uContrast;
        uniform float uSaturation;
        uniform float uTemperature;
        uniform float uTint;

        uniform sampler2D tOverheadShadow;
        uniform sampler2D tBuildingShadow;
        uniform sampler2D tOutdoorsMask;
        uniform float uOverheadShadowOpacity;
        uniform float uBuildingShadowOpacity;
        uniform float uHasOutdoorsMask;

        varying vec2 vUv;
        varying vec2 vScreenUv;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }

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

          return color;
        }

        void main() {
          // Normalized wind direction (fallback to +X if zero)
          vec2 dir = normalize(uWindDir);
          if (length(dir) < 0.001) {
            dir = vec2(1.0, 0.0);
          }

          float speed = clamp(uWindSpeed, 0.0, 1.0);

          // Low-frequency sway: gentle bending over the whole bush area
          float swayPhase = uTime * (6.2831853 * uSwayFrequency) + vUv.y * 3.14159;
          float sway = sin(swayPhase) * uSwayIntensity * speed;

          // High-frequency flutter: fine leaf noise, modulated by hash
          vec2 cell = floor(vUv * uDetailScale);
          float cellHash = hash(cell);
          float flutterPhase = uTime * 12.0 + cellHash * 6.2831853;
          float flutter = sin(flutterPhase) * uFlutterIntensity * speed;

          vec2 offset = dir * (sway + flutter);
          vec2 bushUv = vUv + offset;

          vec4 bushSample = texture2D(uBushMask, bushUv);
          float a = bushSample.a * uIntensity;

          if (a <= 0.001) {
            discard;
          }

          vec3 color = bushSample.rgb;
          color = applyCC(color);

          // Sample overhead and building shadow factors in screen space so
          // bushes inherit the same shadowing as the ground plane. These
          // textures encode 1.0 = fully lit, 0.0 = fully shadowed.
          float shadowFactor = 1.0;
          float buildingFactor = 1.0;

          // Overhead shadows (from OverheadShadowsEffect)
          float shadowTex = texture2D(tOverheadShadow, vScreenUv).r;
          float shadowOpacity = clamp(uOverheadShadowOpacity, 0.0, 1.0);
          shadowFactor = mix(1.0, shadowTex, shadowOpacity);

          // Building shadows (from BuildingShadowsEffect)
          float buildingTex = texture2D(tBuildingShadow, vScreenUv).r;
          float buildingOpacity = clamp(uBuildingShadowOpacity, 0.0, 1.0);
          buildingFactor = mix(1.0, buildingTex, buildingOpacity);

          // Gate both overhead and building shadows by the outdoors mask so
          // indoor foliage is not darkened by outdoor shadow passes. Outdoors
          // convention: bright outside, dark indoors.
          if (uHasOutdoorsMask > 0.5) {
            float outdoorStrength = texture2D(tOutdoorsMask, vScreenUv).r;
            shadowFactor = mix(1.0, shadowFactor, outdoorStrength);
            buildingFactor = mix(1.0, buildingFactor, outdoorStrength);
          }

          float combinedShadowFactor = shadowFactor * buildingFactor;
          color *= combinedShadowFactor;

          gl_FragColor = vec4(color, clamp(a, 0.0, 1.0));
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true
    });

    this.mesh = new THREE.Mesh(this.baseMesh.geometry, this.material);
    this.mesh.position.copy(this.baseMesh.position);
    this.mesh.rotation.copy(this.baseMesh.rotation);
    this.mesh.scale.copy(this.baseMesh.scale);

    // Render just above the base plane / material layer but below overhead tiles
    this.mesh.renderOrder = (this.baseMesh.renderOrder || 0) + 1;

    this.scene.add(this.mesh);
    this.mesh.visible = this._enabled;
  }

  update(timeInfo) {
    if (!this.material || !this.mesh || !this._enabled || !this.bushMask) return;

    const u = this.material.uniforms;
    u.uTime.value = timeInfo.elapsed;

    // Drive from WeatherController if available
    try {
      const state = weatherController?.getCurrentState?.();
      if (state) {
        const dir = state.windDirection;
        if (dir && typeof dir.x === 'number' && typeof dir.y === 'number') {
          u.uWindDir.value.set(dir.x, dir.y);
        }
        if (typeof state.windSpeed === 'number') {
          u.uWindSpeed.value = state.windSpeed;
        }
      }
    } catch (e) {
      // ignore, keep previous wind values
    }

    u.uIntensity.value = this.params.intensity;
    u.uSwayIntensity.value = this.params.swayIntensity;
    u.uSwayFrequency.value = this.params.swayFrequency;
    u.uFlutterIntensity.value = this.params.flutterIntensity;
    u.uDetailScale.value = this.params.detailScale;
    u.uExposure.value = this.params.exposure;
    u.uBrightness.value = this.params.brightness;
    u.uContrast.value = this.params.contrast;
    u.uSaturation.value = this.params.saturation;
    u.uTemperature.value = this.params.temperature;
    u.uTint.value = this.params.tint;

    // Drive shadow textures and opacities from the shared environmental
    // effects so bushes inherit the same shadowing as the ground plane.
    try {
      const mapShine = window.MapShine || window.mapShine;

      // Overhead shadows
      const overhead = mapShine?.overheadShadowsEffect;
      if (overhead && overhead.shadowTarget) {
        u.tOverheadShadow.value = overhead.shadowTarget.texture;
        u.uOverheadShadowOpacity.value = overhead.params?.opacity ?? 0.0;
      } else {
        u.tOverheadShadow.value = null;
        u.uOverheadShadowOpacity.value = 0.0;
      }

      // Building shadows
      const building = mapShine?.buildingShadowsEffect;
      if (building && building.shadowTarget) {
        const THREE = window.THREE;
        const baseOpacity = building.params?.opacity ?? 0.0;
        let ti = 1.0;
        if (THREE && typeof building.timeIntensity === 'number') {
          ti = THREE.MathUtils.clamp(building.timeIntensity, 0.0, 1.0);
        }
        u.tBuildingShadow.value = building.shadowTarget.texture;
        u.uBuildingShadowOpacity.value = baseOpacity * ti;
      } else {
        u.tBuildingShadow.value = null;
        u.uBuildingShadowOpacity.value = 0.0;
      }

      // Outdoors mask (screen-space), projected by LightingEffect
      const lighting = mapShine?.lightingEffect;
      if (lighting && lighting.outdoorsTarget && lighting.outdoorsTarget.texture) {
        u.tOutdoorsMask.value = lighting.outdoorsTarget.texture;
        u.uHasOutdoorsMask.value = 1.0;
      } else {
        u.tOutdoorsMask.value = null;
        u.uHasOutdoorsMask.value = 0.0;
      }
    } catch (e) {
      // In diagnostics or partial initialization states, fail gracefully.
      u.tOverheadShadow.value = null;
      u.tBuildingShadow.value = null;
      u.tOutdoorsMask.value = null;
      u.uOverheadShadowOpacity.value = 0.0;
      u.uBuildingShadowOpacity.value = 0.0;
      u.uHasOutdoorsMask.value = 0.0;
    }

    this.mesh.visible = this._enabled && !!this.bushMask;
  }

  render(renderer, scene, camera) {
    // No off-screen passes required; the mesh lives in the main scene.
  }

  onResize(width, height) {
    // No screen-space resources to resize for this effect.
  }

  dispose() {
    if (this.mesh && this.scene) {
      this.scene.remove(this.mesh);
      this.mesh = null;
    }
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
    this.bushMask = null;
    log.info('BushEffect disposed');
  }
}
