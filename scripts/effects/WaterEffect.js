import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { DistortionLayer } from './DistortionManager.js';

const log = createLogger('WaterEffect');

export class WaterEffect extends EffectBase {
  constructor() {
    super('water', RenderLayers.ENVIRONMENTAL, 'low');

    this.priority = 4;
    this.alwaysRender = true;

    this.enabled = false;

    this.params = {
      intensity: 0.5,
      speed: 0.1,
      scale: 1.0,

      chromaticEnabled: true,
      chromaticAberration: 0.35,
      chromaticMaxPixels: 1.5,

      tintEnabled: false,
      tintColor: { r: 0.10, g: 0.30, b: 0.48 },
      tintStrength: 0.65,
      depthPower: 1.4,

      causticsEnabled: false,
      causticsIntensity: 0.35,
      causticsScale: 10.0,
      causticsSpeed: 0.35,
      causticsSharpness: 3.0,
      causticsEdgeLo: 0.05,
      causticsEdgeHi: 0.55,
      causticsEdgeBlurTexels: 6.0,
      causticsDebug: false,

      debugMask: false
    };

    this.baseMesh = null;
    this.waterMask = null;

    this._sourceRegistered = false;
  }

  static getControlSchema() {
    return {
      enabled: true,
      parameters: {
        intensity: {
          type: 'slider',
          label: 'Intensity',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.5
        },
        speed: {
          type: 'slider',
          label: 'Speed',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.1
        },
        scale: {
          type: 'slider',
          label: 'Scale',
          min: 0.1,
          max: 5,
          step: 0.1,
          default: 1.0
        },

        chromaticEnabled: {
          type: 'checkbox',
          label: 'Chromatic Enabled',
          default: true
        },
        chromaticAberration: {
          type: 'slider',
          label: 'Chromatic Amount',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.35
        },
        chromaticMaxPixels: {
          type: 'slider',
          label: 'Chromatic Max (px)',
          min: 0,
          max: 8,
          step: 0.1,
          default: 1.5
        },

        tintEnabled: {
          type: 'checkbox',
          label: 'Tint Enabled',
          default: false
        },
        tintColor: {
          type: 'color',
          label: 'Tint Color',
          default: { r: 0.10, g: 0.30, b: 0.48 }
        },
        tintStrength: {
          type: 'slider',
          label: 'Tint Strength',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.65
        },
        depthPower: {
          type: 'slider',
          label: 'Depth Power',
          min: 0.1,
          max: 4,
          step: 0.05,
          default: 1.4
        },

        causticsEnabled: {
          type: 'checkbox',
          label: 'Caustics Enabled',
          default: false
        },
        causticsIntensity: {
          type: 'slider',
          label: 'Caustics Intensity',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.35
        },
        causticsScale: {
          type: 'slider',
          label: 'Caustics Scale',
          min: 1,
          max: 40,
          step: 0.25,
          default: 10.0
        },
        causticsSpeed: {
          type: 'slider',
          label: 'Caustics Speed',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.35
        },
        causticsSharpness: {
          type: 'slider',
          label: 'Caustics Sharpness',
          min: 0.1,
          max: 8,
          step: 0.05,
          default: 3.0
        },
        causticsEdgeLo: {
          type: 'slider',
          label: 'Caustics Edge Low',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.05
        },
        causticsEdgeHi: {
          type: 'slider',
          label: 'Caustics Edge High',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 0.55
        },
        causticsEdgeBlurTexels: {
          type: 'slider',
          label: 'Caustics Edge Blur (texels)',
          min: 0.0,
          max: 32.0,
          step: 0.25,
          default: 6.0
        },
        causticsDebug: {
          type: 'checkbox',
          label: 'Caustics Debug',
          default: false
        },

        debugMask: {
          type: 'checkbox',
          label: 'Debug Mask',
          default: false
        }
      }
    };
  }

  setBaseMesh(baseMesh, assetBundle) {
    this.baseMesh = baseMesh;

    const waterMaskData = assetBundle?.masks?.find((m) => m.id === 'water' || m.type === 'water');
    this.waterMask = waterMaskData?.texture || null;

    const THREE = window.THREE;
    if (THREE && this.waterMask) {
      this.waterMask.minFilter = THREE.LinearFilter;
      this.waterMask.magFilter = THREE.LinearFilter;
      this.waterMask.generateMipmaps = false;
      this.waterMask.needsUpdate = true;
    }

    if (!this.waterMask) {
      log.debug('No _Water mask found for this scene');
    }
  }

  update() {
    const dm = window.MapShine?.distortionManager;
    if (!dm) return;

    const p = this.params || {};

    if (!this.enabled || !this.waterMask) {
      if (this._sourceRegistered) {
        dm.setSourceEnabled('water', false);
      }
      return;
    }

    // Water distortion depends on the DistortionManager post-processing pass.
    // If the user has Screen Distortion disabled in the UI, water will otherwise
    // appear to do nothing even though the source is registered.
    dm.enabled = true;
    if (dm.params && Object.prototype.hasOwnProperty.call(dm.params, 'enabled')) {
      dm.params.enabled = true;
    }

    const intensityUi = typeof p.intensity === 'number' ? p.intensity : 0.5;
    const speedUi = typeof p.speed === 'number' ? p.speed : 0.1;
    const scaleUi = typeof p.scale === 'number' ? p.scale : 1.0;

    const debugMask = typeof p.debugMask === 'boolean' ? p.debugMask : false;

    if (debugMask && dm.params) {
      dm.params.debugMode = true;
      dm.params.debugShowMask = true;
    }

    const chromaEnabled = typeof p.chromaticEnabled === 'boolean' ? p.chromaticEnabled : true;
    const chromaUi = typeof p.chromaticAberration === 'number' ? p.chromaticAberration : 0.35;
    const chromaMaxPixels = typeof p.chromaticMaxPixels === 'number' ? p.chromaticMaxPixels : 1.5;

    const tintEnabled = typeof p.tintEnabled === 'boolean' ? p.tintEnabled : false;
    const tintColor = p.tintColor ?? { r: 0.10, g: 0.30, b: 0.48 };
    const tintStrength = typeof p.tintStrength === 'number' ? p.tintStrength : 0.65;
    const depthPower = typeof p.depthPower === 'number' ? p.depthPower : 1.4;

    const causticsEnabled = typeof p.causticsEnabled === 'boolean' ? p.causticsEnabled : false;
    const causticsIntensity = typeof p.causticsIntensity === 'number' ? p.causticsIntensity : 0.35;
    const causticsScale = typeof p.causticsScale === 'number' ? p.causticsScale : 10.0;
    const causticsSpeed = typeof p.causticsSpeed === 'number' ? p.causticsSpeed : 0.35;
    const causticsSharpness = typeof p.causticsSharpness === 'number' ? p.causticsSharpness : 3.0;
    const causticsEdgeLo = typeof p.causticsEdgeLo === 'number' ? p.causticsEdgeLo : 0.05;
    const causticsEdgeHi = typeof p.causticsEdgeHi === 'number' ? p.causticsEdgeHi : 0.55;
    const causticsEdgeBlurTexels = typeof p.causticsEdgeBlurTexels === 'number' ? p.causticsEdgeBlurTexels : 6.0;
    const causticsDebug = typeof p.causticsDebug === 'boolean' ? p.causticsDebug : false;

    const intensity = intensityUi * 0.08;
    const frequency = scaleUi * 6.0;
    const speed = 0.25 + speedUi * 10.0;

    if (!this._sourceRegistered) {
      dm.registerSource('water', DistortionLayer.ABOVE_GROUND, this.waterMask, {
        intensity,
        frequency,
        speed,

        // Chromatic refraction (RGB split) in DistortionManager apply pass
        chromaEnabled,
        chroma: chromaUi,
        chromaMaxPixels,

        // Depth-based tint/absorption
        tintEnabled,
        tintColor,
        tintStrength,
        depthPower,

        // Caustics
        causticsEnabled,
        causticsIntensity,
        causticsScale,
        causticsSpeed,
        causticsSharpness,
        causticsEdgeLo,
        causticsEdgeHi,
        causticsEdgeBlurTexels,
        causticsDebug
      });
      this._sourceRegistered = true;
    } else {
      dm.updateSourceMask('water', this.waterMask);
      dm.updateSourceParams('water', {
        intensity,
        frequency,
        speed,
        chromaEnabled,
        chroma: chromaUi,
        chromaMaxPixels,

        tintEnabled,
        tintColor,
        tintStrength,
        depthPower,

        causticsEnabled,
        causticsIntensity,
        causticsScale,
        causticsSpeed,
        causticsSharpness,
        causticsEdgeLo,
        causticsEdgeHi,
        causticsEdgeBlurTexels,
        causticsDebug
      });
      dm.setSourceEnabled('water', true);
    }
  }

  render() {}

  dispose() {
    const dm = window.MapShine?.distortionManager;
    if (dm && this._sourceRegistered) {
      dm.unregisterSource('water');
    }
    this._sourceRegistered = false;

    super.dispose();
  }
}
