import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { weatherController } from '../core/WeatherController.js';

const log = createLogger('SkyColorEffect');

export class SkyColorEffect extends EffectBase {
  constructor() {
    super('sky-color', RenderLayers.POST_PROCESSING, 'low');

    this.priority = 5;
    
    this.enabled = true;

    // NOTE: Defaults tuned to avoid stacking color correction with ColorCorrectionEffect.
    // Set intensity to 0.2 to enable subtle atmospheric grading by default.
    // See docs/CONTRAST-DARKNESS-ANALYSIS.md for rationale.
    this.params = {
      enabled: true,

      // Master blend of sky grading vs base scene
      // Default 0.2 to provide subtle atmospheric grading - users can increase/decrease as desired
      intensity: 1.0,

      // --- Time-of-day grading presets (blended by timeOfDay) ---
      // Note: These are applied only to outdoors (masked) and then blended by intensity.
      // All values are tuned to be subtle by default; raise intensity for stronger look.

      // Dawn
      dawnExposure: 0.70,
      dawnTemperature: 1.00,
      dawnTint: 0.00,
      dawnBrightness: -0.05,
      dawnContrast: 0.90,
      dawnSaturation: 1.15,
      dawnVibrance: 0.00,
      dawnLiftColor: { r: 0.00, g: 0.00, b: 0.00 },
      dawnGammaColor: { r: 1.00, g: 1.00, b: 1.00 },
      dawnGainColor: { r: 1.00, g: 1.00, b: 1.00 },
      dawnMasterGamma: 1.00,
      dawnToneMapping: 0,
      dawnVignetteStrength: 0.72,
      dawnVignetteSoftness: 1.00,
      dawnGrainStrength: 0.0,

      // Day
      dayExposure: 0.5,
      dayTemperature: 0.0,
      dayTint: 0.0,
      dayBrightness: 0.0,
      dayContrast: 1.02,
      daySaturation: 1.02,
      dayVibrance: 0.0,
      dayLiftColor: { r: 0.00, g: 0.00, b: 0.00 },
      dayGammaColor: { r: 0.50, g: 0.50, b: 0.50 },
      dayGainColor: { r: 1.00, g: 1.00, b: 1.00 },
      dayMasterGamma: 2.0,
      dayToneMapping: 0,
      dayVignetteStrength: 0.0,
      dayVignetteSoftness: 0.5,
      dayGrainStrength: 0.0,

      // Dusk
      duskExposure: 0.7,
      duskTemperature: 1.0,
      duskTint: 0.05,
      duskBrightness: -0.05,
      duskContrast: 0.9,
      duskSaturation: 1.15,
      duskVibrance: 0.15,
      duskLiftColor: { r: 0.00, g: 0.00, b: 0.00 },
      duskGammaColor: { r: 0.54, g: 0.52, b: 0.50 },
      duskGainColor: { r: 1.08, g: 1.02, b: 0.95 },
      duskMasterGamma: 1.00,
      duskToneMapping: 0,
      duskVignetteStrength: 0.72,
      duskVignetteSoftness: 1.0,
      duskGrainStrength: 0.0,

      // Night
      nightExposure: 0.0,
      nightTemperature: -0.5,
      nightTint: 0.0,
      nightBrightness: 0.0,
      nightContrast: 1.00,
      nightSaturation: 0.33,
      nightVibrance: -0.58,
      nightLiftColor: { r: 0.00, g: 0.00, b: 0.00 },
      nightGammaColor: { r: 1.00, g: 1.00, b: 1.00 },
      nightGainColor: { r: 1.00, g: 1.00, b: 1.00 },
      nightMasterGamma: 1.0,
      nightToneMapping: 0,
      nightVignetteStrength: 0.25,
      nightVignetteSoftness: 1.00,
      nightGrainStrength: 0.0,

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
    const stageParams = (prefix, labelPrefix) => {
      const p = (name) => `${prefix}${name}`;
      return {
        groups: [
          {
            name: `${prefix.toLowerCase()}-exposure-wb`,
            label: `${labelPrefix} Exposure & WB`,
            type: 'inline',
            parameters: [p('Exposure'), p('Temperature'), p('Tint')]
          },
          {
            name: `${prefix.toLowerCase()}-basics`,
            label: `${labelPrefix} Basic Adjustments`,
            type: 'inline',
            parameters: [p('Contrast'), p('Brightness'), p('Saturation'), p('Vibrance')]
          },
          {
            name: `${prefix.toLowerCase()}-grading`,
            label: `${labelPrefix} Color Grading`,
            type: 'folder',
            expanded: false,
            parameters: [p('ToneMapping'), p('LiftColor'), p('GammaColor'), p('GainColor'), p('MasterGamma')]
          },
          {
            name: `${prefix.toLowerCase()}-artistic`,
            label: `${labelPrefix} Effects (Vignette/Grain)`,
            type: 'folder',
            expanded: false,
            parameters: [p('VignetteStrength'), p('VignetteSoftness'), p('GrainStrength')]
          }
        ],
        parameters: {
          [p('Exposure')]: { type: 'slider', min: -1, max: 1, step: 0.01, default: 0.0 },
          [p('Temperature')]: { type: 'slider', min: -1, max: 1, step: 0.01, default: 0.0 },
          [p('Tint')]: { type: 'slider', min: -1, max: 1, step: 0.01, default: 0.0 },
          [p('Brightness')]: { type: 'slider', min: -0.5, max: 0.5, step: 0.01, default: 0.0 },
          [p('Contrast')]: { type: 'slider', min: 0, max: 2, step: 0.01, default: 1.0 },
          [p('Saturation')]: { type: 'slider', min: 0, max: 2, step: 0.01, default: 1.0 },
          [p('Vibrance')]: { type: 'slider', min: -1, max: 1, step: 0.01, default: 0.0 },
          [p('LiftColor')]: { type: 'color', default: { r: 0, g: 0, b: 0 } },
          [p('GammaColor')]: { type: 'color', default: { r: 0.5, g: 0.5, b: 0.5 } },
          [p('GainColor')]: { type: 'color', default: { r: 1, g: 1, b: 1 } },
          [p('MasterGamma')]: { type: 'slider', min: 0.1, max: 3, step: 0.01, default: 1.0 },
          [p('ToneMapping')]: {
            type: 'list',
            options: { 'None': 0, 'ACES Filmic': 1, 'Reinhard': 2 },
            default: 0
          },
          [p('VignetteStrength')]: { type: 'slider', min: 0, max: 2, step: 0.01, default: 0.0 },
          [p('VignetteSoftness')]: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.5 },
          [p('GrainStrength')]: { type: 'slider', min: 0, max: 0.5, step: 0.01, default: 0.0 }
        }
      };
    };

    const dawn = stageParams('dawn', 'Dawn');
    const day = stageParams('day', 'Day');
    const dusk = stageParams('dusk', 'Dusk');
    const night = stageParams('night', 'Night');

    // Override Dawn UI defaults to match the tuned SkyColorEffect defaults
    // (so reset/new scenes align with the desired Dawn look)
    dawn.parameters.dawnExposure.default = 0.70;
    dawn.parameters.dawnTemperature.default = 1.00;
    dawn.parameters.dawnTint.default = 0.00;
    dawn.parameters.dawnBrightness.default = -0.05;
    dawn.parameters.dawnContrast.default = 0.90;
    dawn.parameters.dawnSaturation.default = 1.15;
    dawn.parameters.dawnVibrance.default = 0.00;
    dawn.parameters.dawnLiftColor.default = { r: 0.00, g: 0.00, b: 0.00 };
    dawn.parameters.dawnGammaColor.default = { r: 1.00, g: 1.00, b: 1.00 };
    dawn.parameters.dawnGainColor.default = { r: 1.00, g: 1.00, b: 1.00 };
    dawn.parameters.dawnMasterGamma.default = 1.00;
    dawn.parameters.dawnToneMapping.default = 0;
    dawn.parameters.dawnVignetteStrength.default = 0.72;
    dawn.parameters.dawnVignetteSoftness.default = 1.00;
    dawn.parameters.dawnGrainStrength.default = 0.00;

    // Override Night UI defaults to match the tuned SkyColorEffect defaults
    night.parameters.nightExposure.default = 1.00;
    night.parameters.nightTemperature.default = -1.00;
    night.parameters.nightTint.default = -0.25;
    night.parameters.nightBrightness.default = 0.05;
    night.parameters.nightContrast.default = 1.00;
    night.parameters.nightSaturation.default = 0.50;
    night.parameters.nightVibrance.default = 0.00;
    night.parameters.nightLiftColor.default = { r: 0.00, g: 0.00, b: 0.00 };
    night.parameters.nightGammaColor.default = { r: 1.00, g: 1.00, b: 1.00 };
    night.parameters.nightGainColor.default = { r: 1.00, g: 1.00, b: 1.00 };
    night.parameters.nightMasterGamma.default = 0.50;
    night.parameters.nightToneMapping.default = 0;
    night.parameters.nightVignetteStrength.default = 1.00;
    night.parameters.nightVignetteSoftness.default = 1.00;
    night.parameters.nightGrainStrength.default = 0.00;

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
          name: 'time-of-day',
          label: 'Time of Day Grading',
          type: 'folder',
          expanded: false,
          parameters: []
        },
        {
          name: 'dawn',
          label: 'Dawn',
          type: 'folder',
          expanded: false,
          parameters: []
        },
        ...dawn.groups,
        {
          name: 'day',
          label: 'Day',
          type: 'folder',
          expanded: false,
          parameters: []
        },
        ...day.groups,
        {
          name: 'dusk',
          label: 'Dusk',
          type: 'folder',
          expanded: false,
          parameters: []
        },
        ...dusk.groups,
        {
          name: 'night',
          label: 'Night',
          type: 'folder',
          expanded: false,
          parameters: []
        },
        ...night.groups,
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
          default: 0.3,
          label: 'Intensity',
          throttle: 50
        },
        ...dawn.parameters,
        ...day.parameters,
        ...dusk.parameters,
        ...night.parameters,
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
        tCloudTop: { value: null },
        uHasCloudTop: { value: 0.0 },
        uTime: { value: 0.0 },
        uResolution: { value: new THREE.Vector2(1, 1) },

        // Grading params (blended per time-of-day)
        uExposure: { value: 0.0 },
        uTemperature: { value: 0.0 },
        uTint: { value: 0.0 },
        uBrightness: { value: 0.0 },
        uContrast: { value: 1.0 },
        uSaturation: { value: 1.0 },
        uVibrance: { value: 0.0 },

        uLift: { value: new THREE.Vector3(0, 0, 0) },
        uGamma: { value: new THREE.Vector3(1, 1, 1) },
        uGain: { value: new THREE.Vector3(1, 1, 1) },
        uMasterGamma: { value: 1.0 },
        uToneMapping: { value: 0 },

        uVignetteStrength: { value: 0.0 },
        uVignetteSoftness: { value: 0.5 },
        uGrainStrength: { value: 0.0 },

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
        uniform sampler2D tCloudTop;
        uniform float uHasCloudTop;
        uniform vec2 uResolution;
        uniform float uTime;

        uniform float uExposure;
        uniform float uTemperature;
        uniform float uTint;
        uniform float uBrightness;
        uniform float uContrast;
        uniform float uSaturation;
        uniform float uVibrance;
        uniform vec3 uLift;
        uniform vec3 uGamma;
        uniform vec3 uGain;
        uniform float uMasterGamma;
        uniform int uToneMapping;
        uniform float uVignetteStrength;
        uniform float uVignetteSoftness;
        uniform float uGrainStrength;
        uniform float uIntensity;

        varying vec2 vUv;

        vec3 ACESFilmicToneMapping(vec3 x) {
          float a = 2.51;
          float b = 0.03;
          float c = 2.43;
          float d = 0.59;
          float e = 0.14;
          return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
        }

        vec3 ReinhardToneMapping(vec3 x) {
          return x / (x + vec3(1.0));
        }

        vec3 applyWhiteBalance(vec3 color, float temp, float tint) {
          vec3 tempShift = vec3(1.0 + temp, 1.0, 1.0 - temp);
          if (temp < 0.0) tempShift = vec3(1.0, 1.0, 1.0 - temp * 0.5);
          else tempShift = vec3(1.0 + temp * 0.5, 1.0, 1.0);

          vec3 tintShift = vec3(1.0, 1.0 + tint, 1.0);
          return color * tempShift * tintShift;
        }

        float random(vec2 p) {
          return fract(sin(dot(p.xy, vec2(12.9898, 78.233))) * 43758.5453);
        }

        void main() {
          vec4 sceneColor = texture2D(tDiffuse, vUv);
          vec3 base = sceneColor.rgb;

          float outdoors = 1.0;
          if (uHasOutdoorsMask > 0.5) {
            outdoors = texture2D(tOutdoorsMask, vUv).r;
          }

          float cloudTopAlpha = 0.0;
          if (uHasCloudTop > 0.5) {
            cloudTopAlpha = texture2D(tCloudTop, vUv).a;
          }

          float gradeMask = outdoors;

          if (uIntensity <= 0.0 || gradeMask <= 0.0) {
            gl_FragColor = sceneColor;
            return;
          }

          vec3 color = base;

          // 1) Exposure (stops)
          color *= exp2(uExposure);

          // 2) White balance
          color = applyWhiteBalance(color, uTemperature, uTint);

          // 3) Basic adjustments
          color += uBrightness;
          color = (color - 0.5) * uContrast + 0.5;

          float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
          vec3 gray = vec3(luma);
          float sat = max(color.r, max(color.g, color.b)) - min(color.r, min(color.g, color.b));
          vec3 satColor = mix(gray, color, uSaturation);
          if (uVibrance != 0.0) {
            satColor = mix(satColor, mix(gray, satColor, 1.0 + uVibrance), (1.0 - sat));
          }
          color = satColor;

          // 4) Lift/Gamma/Gain
          color = color + (uLift * 0.1);
          color = color * uGain;
          color = max(color, vec3(0.0));
          color = pow(color, 1.0 / uGamma);
          if (uMasterGamma != 1.0) {
            color = pow(color, vec3(1.0 / max(uMasterGamma, 0.0001)));
          }

          // 5) Tone mapping (optional)
          if (uToneMapping == 1) {
            color = ACESFilmicToneMapping(color);
          } else if (uToneMapping == 2) {
            color = ReinhardToneMapping(color);
          }

          // 6) VFX
          vec2 dist = (vUv - 0.5) * 2.0;
          float len = length(dist);
          if (uVignetteStrength > 0.0) {
            float soft = clamp(uVignetteSoftness, 0.0, 1.0);
            float inner = mix(0.85, 0.35, soft);
            float outer = mix(1.25, 0.85, soft);
            float vig = 1.0 - smoothstep(inner, outer, len);
            color *= mix(1.0, vig, uVignetteStrength);
          }

          if (uGrainStrength > 0.0) {
            float noise = random(vUv + uTime);
            color += (noise - 0.5) * uGrainStrength;
          }

          float mask = clamp(gradeMask * uIntensity, 0.0, 1.0);
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
      const hourRaw = weatherController?.timeOfDay ?? 12.0;
      const hour = ((hourRaw % 24) + 24) % 24;

      // Time-of-day weights (normalized)
      const clamp01 = (n) => Math.max(0, Math.min(1, n));
      const wrapDistHours = (a, b) => {
        const d = Math.abs(a - b);
        return Math.min(d, 24 - d);
      };
      const smooth01 = (x) => x * x * (3 - 2 * x);
      const peak = (center, widthHours) => {
        const d = wrapDistHours(hour, center);
        const t = clamp01(1 - d / Math.max(0.0001, widthHours));
        return smooth01(t);
      };

      const wDawn = peak(6.0, 3.0);
      const wDay = peak(12.0, 5.5);
      const wDusk = peak(18.0, 3.0);
      const wNight = peak(0.0, 6.5);
      const wSum = Math.max(0.0001, wDawn + wDay + wDusk + wNight);
      const wd = wDawn / wSum;
      const wday = wDay / wSum;
      const wdu = wDusk / wSum;
      const wn = wNight / wSum;

      const blend4 = (a, b, c, d) => a * wd + b * wday + c * wdu + d * wn;
      const blendColor4 = (a, b, c, d) => ({
        r: a.r * wd + b.r * wday + c.r * wdu + d.r * wn,
        g: a.g * wd + b.g * wday + c.g * wdu + d.g * wn,
        b: a.b * wd + b.b * wday + c.b * wdu + d.b * wn
      });

      const dawnLift = this.params.dawnLiftColor;
      const dawnGamma = this.params.dawnGammaColor;
      const dawnGain = this.params.dawnGainColor;
      const dayLift = this.params.dayLiftColor;
      const dayGamma = this.params.dayGammaColor;
      const dayGain = this.params.dayGainColor;
      const duskLift = this.params.duskLiftColor;
      const duskGamma = this.params.duskGammaColor;
      const duskGain = this.params.duskGainColor;
      const nightLift = this.params.nightLiftColor;
      const nightGamma = this.params.nightGammaColor;
      const nightGain = this.params.nightGainColor;

      let exposure = blend4(this.params.dawnExposure, this.params.dayExposure, this.params.duskExposure, this.params.nightExposure);
      const temperature = blend4(this.params.dawnTemperature, this.params.dayTemperature, this.params.duskTemperature, this.params.nightTemperature);
      const tint = blend4(this.params.dawnTint, this.params.dayTint, this.params.duskTint, this.params.nightTint);
      const brightness = blend4(this.params.dawnBrightness, this.params.dayBrightness, this.params.duskBrightness, this.params.nightBrightness);
      let contrast = blend4(this.params.dawnContrast, this.params.dayContrast, this.params.duskContrast, this.params.nightContrast);
      let saturation = blend4(this.params.dawnSaturation, this.params.daySaturation, this.params.duskSaturation, this.params.nightSaturation);
      const vibrance = blend4(this.params.dawnVibrance, this.params.dayVibrance, this.params.duskVibrance, this.params.nightVibrance);
      const lift = blendColor4(dawnLift, dayLift, duskLift, nightLift);
      const gammaColor = blendColor4(dawnGamma, dayGamma, duskGamma, nightGamma);
      const gainColor = blendColor4(dawnGain, dayGain, duskGain, nightGain);
      const masterGamma = blend4(this.params.dawnMasterGamma, this.params.dayMasterGamma, this.params.duskMasterGamma, this.params.nightMasterGamma);
      const vignetteStrength = blend4(this.params.dawnVignetteStrength, this.params.dayVignetteStrength, this.params.duskVignetteStrength, this.params.nightVignetteStrength);
      const vignetteSoftness = blend4(this.params.dawnVignetteSoftness, this.params.dayVignetteSoftness, this.params.duskVignetteSoftness, this.params.nightVignetteSoftness);
      const grainStrength = blend4(this.params.dawnGrainStrength, this.params.dayGrainStrength, this.params.duskGrainStrength, this.params.nightGrainStrength);

      // Tone mapping isn't meaningfully blendable. Use the dominant stage.
      let toneMapping = this.params.dayToneMapping;
      let wMax = wday;
      if (wd > wMax) { wMax = wd; toneMapping = this.params.dawnToneMapping; }
      if (wdu > wMax) { wMax = wdu; toneMapping = this.params.duskToneMapping; }
      if (wn > wMax) { wMax = wn; toneMapping = this.params.nightToneMapping; }

      if (this.params.debugOverride) {
        // Manual override for core values (kept for compatibility)
        exposure = this.params.exposure;
        saturation = this.params.saturation;
        contrast = this.params.contrast;
      } else {
        this.params.exposure = exposure;
        this.params.saturation = saturation;
        this.params.contrast = contrast;
      }

      const u = this.material.uniforms;
      u.uTime.value = timeInfo.elapsed;
      u.uResolution.value.set(this.renderer?.domElement?.width ?? 1, this.renderer?.domElement?.height ?? 1);

      u.uExposure.value = exposure;
      u.uTemperature.value = temperature;
      u.uTint.value = tint;
      u.uBrightness.value = brightness;
      u.uContrast.value = contrast;
      u.uSaturation.value = saturation;
      u.uVibrance.value = vibrance;

      u.uLift.value.set(lift.r, lift.g, lift.b);
      u.uGamma.value.set(Math.max(0.0001, gammaColor.r), Math.max(0.0001, gammaColor.g), Math.max(0.0001, gammaColor.b));
      u.uGain.value.set(gainColor.r, gainColor.g, gainColor.b);
      u.uMasterGamma.value = masterGamma ?? 1.0;
      u.uToneMapping.value = toneMapping;
      u.uVignetteStrength.value = vignetteStrength;
      u.uVignetteSoftness.value = vignetteSoftness;
      u.uGrainStrength.value = grainStrength;
      u.uIntensity.value = this.params.intensity;

      const cloudEffect = window.MapShine?.cloudEffect;
      const cloudTopTex = cloudEffect?.cloudTopTarget?.texture ?? null;
      if (cloudTopTex) {
        u.tCloudTop.value = cloudTopTex;
        u.uHasCloudTop.value = 1.0;
      } else {
        u.uHasCloudTop.value = 0.0;
      }

      const mm = window.MapShine?.maskManager;
      const outdoorsTex = mm ? mm.getTexture('outdoors.screen') : null;
      if (outdoorsTex) {
        u.tOutdoorsMask.value = outdoorsTex;
        u.uHasOutdoorsMask.value = 1.0;
      } else {
        const le = window.MapShine?.lightingEffect;
        if (le && le.outdoorsTarget) {
          u.tOutdoorsMask.value = le.outdoorsTarget.texture;
          u.uHasOutdoorsMask.value = 1.0;
        } else {
          u.uHasOutdoorsMask.value = 0.0;
        }
      }
    } catch (e) {
      if (Math.random() < 0.01) {
        log.warn('SkyColorEffect update failed', e);
      }
    }
  }

  render(renderer, scene, camera) {
    if (!this.material) return;

    const inputTexture = this.readBuffer ? this.readBuffer.texture : this.material.uniforms.tDiffuse.value;
    if (!inputTexture) return;

    this.material.uniforms.tDiffuse.value = inputTexture;

    const prevIntensity = this.material.uniforms?.uIntensity?.value;
    if (!this.enabled && this.material.uniforms?.uIntensity) {
      this.material.uniforms.uIntensity.value = 0.0;
    }

    if (this.writeBuffer) {
      renderer.setRenderTarget(this.writeBuffer);
      renderer.clear();
    } else {
      renderer.setRenderTarget(null);
    }

    renderer.render(this.quadScene, this.quadCamera);

    if (!this.enabled && this.material.uniforms?.uIntensity) {
      this.material.uniforms.uIntensity.value = prevIntensity;
    }
  }
}
