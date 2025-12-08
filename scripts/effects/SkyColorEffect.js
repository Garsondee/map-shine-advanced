import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { weatherController } from '../core/WeatherController.js';

const log = createLogger('SkyColorEffect');

export class SkyColorEffect extends EffectBase {
  constructor() {
    super('sky-color', RenderLayers.POST_PROCESSING, 'low');

    this.priority = 5;

    // NOTE: Defaults tuned to avoid stacking color correction with ColorCorrectionEffect.
    // Set intensity to 0 by default so users can opt-in to atmospheric grading.
    // See docs/CONTRAST-DARKNESS-ANALYSIS.md for rationale.
    this.params = {
      enabled: true,

      // Master blend of sky grading vs base scene
      // Default 0 to avoid double color correction - users can increase for atmospheric look
      intensity: 0.0,

      // Automation vs manual override
      debugOverride: false,

      // Manually editable exposure/saturation/contrast when debugOverride is true
      exposure: 0.0,
      saturation: 1.0,
      contrast: 1.0
    };

    this.material = null;
    this.quadScene = null;
    this.quadCamera = null;

    this.readBuffer = null;
    this.writeBuffer = null;
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'sky-color',
          label: 'Sky Color',
          type: 'inline',
          parameters: ['intensity']
        },
        {
          name: 'automation',
          label: 'Automation vs Manual',
          type: 'inline',
          separator: true,
          parameters: ['debugOverride', 'exposure', 'saturation', 'contrast']
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: true },
        intensity: {
          type: 'slider',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.0,
          label: 'Intensity',
          throttle: 50
        },
        debugOverride: {
          type: 'boolean',
          default: false,
          label: 'Manual Override'
        },
        exposure: {
          type: 'slider',
          min: -1,
          max: 1,
          step: 0.01,
          default: 0.0,
          label: 'Exposure (Manual)',
          throttle: 50
        },
        saturation: {
          type: 'slider',
          min: 0,
          max: 2,
          step: 0.01,
          default: 1.0,
          label: 'Saturation (Manual)',
          throttle: 50
        },
        contrast: {
          type: 'slider',
          min: 0.5,
          max: 1.5,
          step: 0.01,
          default: 1.0,
          label: 'Contrast (Manual)',
          throttle: 50
        }
      }
    };
  }

  initialize(renderer, scene, camera) {
    const THREE = window.THREE;

    this.renderer = renderer;

    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tOutdoorsMask: { value: null },
        uHasOutdoorsMask: { value: 0.0 },
        uExposure: { value: 0.0 },
        uSaturation: { value: 1.0 },
        uContrast: { value: 1.0 },
        uIntensity: { value: 1.0 }
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
        uniform sampler2D tOutdoorsMask;
        uniform float uHasOutdoorsMask;
        uniform float uExposure;
        uniform float uSaturation;
        uniform float uContrast;
        uniform float uIntensity;

        varying vec2 vUv;

        vec3 adjustSaturation(vec3 color, float value) {
          vec3 gray = vec3(dot(color, vec3(0.2126, 0.7152, 0.0722)));
          return mix(gray, color, value);
        }

        void main() {
          vec4 sceneColor = texture2D(tDiffuse, vUv);
          vec3 base = sceneColor.rgb;

          float outdoors = 1.0;
          if (uHasOutdoorsMask > 0.5) {
            outdoors = texture2D(tOutdoorsMask, vUv).r;
          }

          if (uIntensity <= 0.0 || outdoors <= 0.0) {
            gl_FragColor = sceneColor;
            return;
          }

          vec3 color = base;

          color *= exp2(uExposure);
          color = adjustSaturation(color, uSaturation);
          color = (color - 0.5) * uContrast + 0.5;

          float mask = clamp(outdoors * uIntensity, 0.0, 1.0);
          vec3 finalColor = mix(base, color, mask);

          gl_FragColor = vec4(finalColor, sceneColor.a);
        }
      `,
      depthWrite: false,
      depthTest: false
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quadScene.add(quad);
  }

  setBuffers(readBuffer, writeBuffer) {
    this.readBuffer = readBuffer;
    this.writeBuffer = writeBuffer;
  }

  setInputTexture(texture) {
    if (this.material) {
      this.material.uniforms.tDiffuse.value = texture;
    }
  }

  update(timeInfo) {
    if (!this.material) return;

    try {
      const state = weatherController?.getCurrentState?.();
      const hour = weatherController?.timeOfDay ?? 12.0;

      let exposure = 0.0;
      let saturation = 1.0;
      let contrast = 1.0;

      // Map hour (0-24) to a smooth day factor where:
      //  - 12.0 (noon)     -> dayFactor = 1.0
      //  - 0.0 / 24.0      -> dayFactor = 0.0 (midnight)
      //  - 6.0 / 18.0      -> mid ramp (golden hours)
      const TWO_PI = 6.283185307179586;
      const angle = ((hour - 12.0) % 24) / 24 * TWO_PI;
      const dayFactor = 0.5 * (Math.cos(angle) + 1.0);

      const precip = state?.precipitation ?? 0.0;
      const cloud = state?.cloudCover ?? 0.0;
      const freezeLevel = state?.freezeLevel ?? 0.0; // 0 = warm rain, 1 = full snow/cold
      const stormFactor = Math.max(0.0, precip - 0.5) * 2.0;
      const overcastFactor = Math.min(1.0, (precip + cloud) * 0.5);

      // Temperature influence:
      // freezeLevel 0.0  -> warm (rain only)
      // freezeLevel 1.0  -> cold (snow/ice)
      // We bias exposure/saturation/contrast slightly based on temperature,
      // with stronger influence at night so cold, snowy nights feel darker
      // and more muted than warm rainy nights.
      const nightFactor = 1.0 - dayFactor; // 0 = noon, 1 = midnight
      const tempInfluence = freezeLevel * nightFactor;

      const baseExposureDay = 0.2;
      const baseExposureNight = -0.8;
      const baseSatDay = 1.1;
      const baseSatNight = 0.6;
      const baseConDay = 1.1;
      const baseConNight = 1.3;

      let baseExposure = baseExposureNight + (baseExposureDay - baseExposureNight) * dayFactor;
      let baseSat = baseSatNight + (baseSatDay - baseSatNight) * dayFactor;
      let baseCon = baseConNight + (baseConDay - baseConNight) * dayFactor;

      const stormExposure = -0.6;
      const stormSat = 0.6;
      const stormCon = 0.7;

      // First blend towards storm/overcast behaviour based on precipitation/clouds.
      exposure = baseExposure + (stormExposure - baseExposure) * stormFactor;
      saturation = baseSat + (stormSat - baseSat) * overcastFactor;
      contrast = baseCon + (stormCon - baseCon) * overcastFactor;

      // Then apply a subtle temperature adjustment, strongest on cold nights.
      // Colder -> slightly darker, slightly less saturated, a touch more contrast.
      if (tempInfluence > 0.0) {
        const coldExposureOffset = -0.3 * tempInfluence;
        const coldSatScale = 1.0 - 0.25 * tempInfluence;
        const coldConScale = 1.0 + 0.15 * tempInfluence;

        exposure += coldExposureOffset;
        saturation *= coldSatScale;
        contrast *= coldConScale;
      }

      if (this.params.debugOverride) {
        exposure = this.params.exposure;
        saturation = this.params.saturation;
        contrast = this.params.contrast;
      } else {
        this.params.exposure = exposure;
        this.params.saturation = saturation;
        this.params.contrast = contrast;
      }

      const u = this.material.uniforms;
      u.uExposure.value = exposure;
      u.uSaturation.value = saturation;
      u.uContrast.value = contrast;
      u.uIntensity.value = this.params.intensity;

      const le = window.MapShine?.lightingEffect;
      if (le && le.outdoorsTarget) {
        u.tOutdoorsMask.value = le.outdoorsTarget.texture;
        u.uHasOutdoorsMask.value = 1.0;
      } else {
        u.uHasOutdoorsMask.value = 0.0;
      }
    } catch (e) {
      if (Math.random() < 0.01) {
        log.warn('SkyColorEffect update failed', e);
      }
    }
  }

  render(renderer, scene, camera) {
    if (!this.enabled || !this.material) return;

    const inputTexture = this.readBuffer ? this.readBuffer.texture : this.material.uniforms.tDiffuse.value;
    if (!inputTexture) return;

    this.material.uniforms.tDiffuse.value = inputTexture;

    if (this.writeBuffer) {
      renderer.setRenderTarget(this.writeBuffer);
      renderer.clear();
    } else {
      renderer.setRenderTarget(null);
    }

    renderer.render(this.quadScene, this.quadCamera);
  }
}
