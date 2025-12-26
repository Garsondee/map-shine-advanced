import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { DistortionLayer } from './DistortionManager.js';
import { weatherController } from '../core/WeatherController.js';

const log = createLogger('WaterEffect');

export class WaterEffect extends EffectBase {
  constructor() {
    super('water', RenderLayers.ENVIRONMENTAL, 'low');

    this.priority = 4;
    this.alwaysRender = true;

    this._enabled = false;

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

      rainRipplesEnabled: true,
      rainRippleIntensityBoost: 1.0,
      rainRippleSpeedBoost: 0.65,
      rainRippleScale: 2.0,

      edgeSoftnessTexels: 6.0,

      windFoamEnabled: false,
      windFoamIntensity: 1.0,
      windFoamTiles: 6.0,
      windFoamScale: 10.0,
      windFoamSpeed: 0.25,
      windFoamThreshold: 0.7,
      windFoamSoftness: 0.25,
      windFoamStreakiness: 2.8,
      windFoamDepthLo: 0.25,
      windFoamDepthHi: 0.75,
      windFoamColor: { r: 1.0, g: 1.0, b: 1.0 },

      shoreFoamEnabled: false,
      shoreFoamIntensity: 1.0,

      debugMask: false
    };

    this.baseMesh = null;
    this.waterMask = null;

    this._sourceRegistered = false;

    this._dmDebugOwned = false;
    this._dmPrevDebugMode = false;
    this._dmPrevDebugShowMask = false;

    this._waterMaskFlipY = 0.0;
    this._waterMaskUseAlpha = 0.0;

    this._windFoamPhase = 0.0;
  }

  get enabled() {
    return this._enabled;
  }

  set enabled(value) {
    this._enabled = !!value;

    if (!this._enabled) {
      const dm = window.MapShine?.distortionManager;
      if (dm && this._sourceRegistered) {
        dm.setSourceEnabled('water', false);
      }

      if (this._dmDebugOwned && dm?.params) {
        dm.params.debugMode = this._dmPrevDebugMode;
        dm.params.debugShowMask = this._dmPrevDebugShowMask;
        this._dmDebugOwned = false;
      }
    }
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
          max: 16,
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

        rainRipplesEnabled: {
          type: 'checkbox',
          label: 'Rain Ripples',
          default: true
        },
        rainRippleIntensityBoost: {
          type: 'slider',
          label: 'Rain Ripple Intensity',
          min: 0,
          max: 4,
          step: 0.05,
          default: 1.0
        },
        rainRippleSpeedBoost: {
          type: 'slider',
          label: 'Rain Ripple Speed',
          min: 0,
          max: 4,
          step: 0.05,
          default: 0.65
        },
        rainRippleScale: {
          type: 'slider',
          label: 'Rain Ripple Scale',
          min: 0.25,
          max: 8.0,
          step: 0.05,
          default: 2.0
        },

        edgeSoftnessTexels: {
          type: 'slider',
          label: 'Edge Softness (texels)',
          min: 0.0,
          max: 32.0,
          step: 0.25,
          default: 6.0
        },

        windFoamEnabled: {
          type: 'checkbox',
          label: 'Wind Foam',
          default: false
        },
        windFoamIntensity: {
          type: 'slider',
          label: 'Wind Foam Intensity',
          min: 0,
          max: 4,
          step: 0.05,
          default: 1.0
        },
        windFoamTiles: {
          type: 'slider',
          label: 'Wind Foam Tiles',
          min: 1,
          max: 20,
          step: 1,
          default: 6.0
        },
        windFoamScale: {
          type: 'slider',
          label: 'Wind Foam Scale',
          min: 1,
          max: 40,
          step: 0.25,
          default: 10.0
        },
        windFoamSpeed: {
          type: 'slider',
          label: 'Wind Foam Speed',
          min: 0,
          max: 2,
          step: 0.01,
          default: 0.25
        },
        windFoamThreshold: {
          type: 'slider',
          label: 'Wind Foam Threshold',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.7
        },
        windFoamSoftness: {
          type: 'slider',
          label: 'Wind Foam Softness',
          min: 0.01,
          max: 0.75,
          step: 0.01,
          default: 0.25
        },
        windFoamStreakiness: {
          type: 'slider',
          label: 'Wind Foam Streakiness',
          min: 0.25,
          max: 12,
          step: 0.05,
          default: 2.8
        },
        windFoamDepthLo: {
          type: 'slider',
          label: 'Wind Foam Depth Lo',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.25
        },
        windFoamDepthHi: {
          type: 'slider',
          label: 'Wind Foam Depth Hi',
          min: 0,
          max: 1,
          step: 0.01,
          default: 0.75
        },
        windFoamColor: {
          type: 'color',
          label: 'Wind Foam Color',
          default: { r: 1.0, g: 1.0, b: 1.0 }
        },

        shoreFoamEnabled: {
          type: 'checkbox',
          label: 'Shore Foam',
          default: false
        },
        shoreFoamIntensity: {
          type: 'slider',
          label: 'Shore Foam Intensity',
          min: 0,
          max: 4,
          step: 0.05,
          default: 1.0
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

      this._waterMaskFlipY = 0.0;
      if (!this.waterMask.flipY) {
        this.waterMask.flipY = true;
      }

      try {
        const img = this.waterMask.image;
        if (img && (img instanceof HTMLImageElement || img instanceof HTMLCanvasElement || img instanceof ImageBitmap || img instanceof OffscreenCanvas || img instanceof HTMLVideoElement)) {
          const canvas = document.createElement('canvas');
          const w = 32;
          const h = 32;
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(img, 0, 0, w, h);
            const data = ctx.getImageData(0, 0, w, h).data;
            let rMin = 255;
            let rMax = 0;
            let aMin = 255;
            let aMax = 0;
            for (let i = 0; i < data.length; i += 4) {
              const r = data[i];
              const a = data[i + 3];
              if (r < rMin) rMin = r;
              if (r > rMax) rMax = r;
              if (a < aMin) aMin = a;
              if (a > aMax) aMax = a;
            }
            const rRange = rMax - rMin;
            const aRange = aMax - aMin;
            if (aRange > rRange + 8) {
              this._waterMaskUseAlpha = 1.0;
            } else {
              this._waterMaskUseAlpha = 0.0;
            }
          }
        }
      } catch (_) {
        this._waterMaskUseAlpha = 0.0;
      }

      this.waterMask.needsUpdate = true;
    }

    if (!this.waterMask) {
      log.debug('No _Water mask found for this scene');
    }
  }

  update(timeInfo) {
    const dm = window.MapShine?.distortionManager;
    if (!dm) {
      try {
        if (window.MapShine) {
          window.MapShine._waterFoamDebug = {
            status: 'inactive',
            reason: 'no_distortion_manager'
          };
        }
      } catch (_) {
      }
      return;
    }

    const wc = window.MapShine?.weatherController || weatherController;

    const p = this.params || {};

    if (!this.enabled || !this.waterMask) {
      try {
        if (window.MapShine) {
          window.MapShine._waterFoamDebug = {
            status: 'inactive',
            reason: !this.enabled ? 'water_effect_disabled' : 'no_water_mask',
            waterEffectEnabled: !!this.enabled,
            hasWaterMask: !!this.waterMask,
            sourceRegistered: !!this._sourceRegistered,
            windFoamEnabled: !!this.params?.windFoamEnabled
          };
        }
      } catch (_) {
      }
      if (this._dmDebugOwned && dm.params) {
        dm.params.debugMode = this._dmPrevDebugMode;
        dm.params.debugShowMask = this._dmPrevDebugShowMask;
        this._dmDebugOwned = false;
      }
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

    if (dm.params) {
      if (debugMask) {
        if (!this._dmDebugOwned) {
          this._dmPrevDebugMode = !!dm.params.debugMode;
          this._dmPrevDebugShowMask = !!dm.params.debugShowMask;
          this._dmDebugOwned = true;
        }
        dm.params.debugMode = true;
        dm.params.debugShowMask = true;
      } else if (this._dmDebugOwned) {
        dm.params.debugMode = this._dmPrevDebugMode;
        dm.params.debugShowMask = this._dmPrevDebugShowMask;
        this._dmDebugOwned = false;
      }
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

    const windFoamEnabled = typeof p.windFoamEnabled === 'boolean' ? p.windFoamEnabled : false;
    const windFoamIntensity = typeof p.windFoamIntensity === 'number' ? p.windFoamIntensity : 1.0;
    const windFoamTiles = typeof p.windFoamTiles === 'number' ? p.windFoamTiles : 6.0;
    const windFoamScale = typeof p.windFoamScale === 'number' ? p.windFoamScale : 10.0;
    const windFoamSpeed = typeof p.windFoamSpeed === 'number' ? p.windFoamSpeed : 0.25;
    const windFoamThreshold = typeof p.windFoamThreshold === 'number' ? p.windFoamThreshold : 0.7;
    const windFoamSoftness = typeof p.windFoamSoftness === 'number' ? p.windFoamSoftness : 0.25;
    const windFoamStreakiness = typeof p.windFoamStreakiness === 'number' ? p.windFoamStreakiness : 2.8;
    const windFoamDepthLo = typeof p.windFoamDepthLo === 'number' ? p.windFoamDepthLo : 0.25;
    const windFoamDepthHi = typeof p.windFoamDepthHi === 'number' ? p.windFoamDepthHi : 0.75;
    const windFoamColor = p.windFoamColor ?? { r: 1.0, g: 1.0, b: 1.0 };

    let intensity = intensityUi * 0.08;
    let frequency = scaleUi * 6.0;
    let speed = 0.25 + speedUi * 10.0;

    const rainRipplesEnabled = typeof p.rainRipplesEnabled === 'boolean' ? p.rainRipplesEnabled : true;
    const rainRippleIntensityBoost = typeof p.rainRippleIntensityBoost === 'number' ? p.rainRippleIntensityBoost : 1.0;
    const rainRippleSpeedBoost = typeof p.rainRippleSpeedBoost === 'number' ? p.rainRippleSpeedBoost : 0.65;
    const rainRippleScale = typeof p.rainRippleScale === 'number' ? p.rainRippleScale : 2.0;

    const edgeSoftnessTexels = typeof p.edgeSoftnessTexels === 'number' ? p.edgeSoftnessTexels : 6.0;

    let weatherState = null;
    if ((rainRipplesEnabled || windFoamEnabled) && wc && typeof wc.getCurrentState === 'function') {
      weatherState = wc.getCurrentState();
    }

    if (rainRipplesEnabled && weatherState) {
      const precip = weatherState?.precipitation ?? 0;
      const freeze = weatherState?.freezeLevel ?? 0;
      const rainFactor = Math.max(0, Math.min(1, precip * (1.0 - freeze)));

      intensity *= (1.0 + rainFactor * rainRippleIntensityBoost);
      speed *= (1.0 + rainFactor * rainRippleSpeedBoost);
      frequency *= (1.0 + rainFactor * 0.15);
      frequency *= (1.0 + rainFactor * Math.max(0.0, rainRippleScale));
    }

    let windDirX = 1.0;
    let windDirY = 0.0;
    let windSpeed01 = 0.0;
    // Rebuild wind direction logic for wind foam:
    // - Direction should follow the UI setting exactly => use targetState.windDirection when available.
    // - Speed can still come from currentState (gusts/variability).
    // - Convert once into the same UV convention the water mask sampling uses.
    if (wc) {
      const wdTarget = wc?.targetState?.windDirection;
      const wdCurrent = weatherState?.windDirection;
      const ws = weatherState?.windSpeed;

      let windDirSource = 'none';

      const wd = (wdTarget && Number.isFinite(wdTarget.x) && Number.isFinite(wdTarget.y))
        ? (windDirSource = 'target', wdTarget)
        : (wdCurrent && Number.isFinite(wdCurrent.x) && Number.isFinite(wdCurrent.y))
          ? (windDirSource = 'current', wdCurrent)
          : null;

      if (wd && Number.isFinite(wd.x) && Number.isFinite(wd.y)) {
        const len = Math.hypot(wd.x, wd.y) || 1.0;
        windDirX = wd.x / len;
        windDirY = wd.y / len;

        // Convert from UI/world Y-down to water-mask UV convention.
        // If the mask is not flipped (flipY=0), we invert Y here.
        // If the mask is already flipped (flipY=1), we keep Y as-is.
        if (this._waterMaskFlipY <= 0.5) {
          windDirY *= -1.0;
        }
      }
      if (Number.isFinite(ws)) {
        windSpeed01 = ws;
      }
    }

    // Integrate wind foam advection phase to avoid "ping-pong" behavior when wind speed changes.
    // Using absolute time * varying speed creates apparent backtracking as gust envelopes rise/fall.
    // Instead: phase += velocity * dt (monotonic). Direction changes still steer the scroll.
    let dt = Number.isFinite(timeInfo?.delta) ? timeInfo.delta : 0.0;
    dt = Math.max(0.0, Math.min(dt, 0.1));

    const windSpeedClamped = Math.max(0.0, Math.min(1.0, windSpeed01));
    const foamVelocity = windFoamEnabled
      ? (windFoamSpeed * (0.25 + windSpeedClamped * 2.0))
      : 0.0;

    if (Number.isFinite(foamVelocity) && foamVelocity !== 0.0 && dt > 0.0) {
      this._windFoamPhase += foamVelocity * dt;
      // Prevent unbounded growth (keeps float precision stable over long sessions).
      if (this._windFoamPhase > 10000.0) this._windFoamPhase -= 10000.0;
      if (this._windFoamPhase < -10000.0) this._windFoamPhase += 10000.0;
    }

    const windFoamPhase = this._windFoamPhase;

    try {
      if (window.MapShine) {
        window.MapShine._waterFoamDebug = {
          wcEnabled: !!wc?.enabled,
          usedWindDir: { x: windDirX, y: windDirY },
          windDirSource,
          targetWindDir: wc?.targetState?.windDirection ? { x: wc.targetState.windDirection.x, y: wc.targetState.windDirection.y } : null,
          currentWindDir: weatherState?.windDirection ? { x: weatherState.windDirection.x, y: weatherState.windDirection.y } : null,
          windSpeed01,
          windFoamPhase,
          maskFlipY: this._waterMaskFlipY,
          windFoamEnabled
        };
      }
    } catch (_) {
    }

    if (!this._sourceRegistered) {
      dm.registerSource('water', DistortionLayer.ABOVE_GROUND, this.waterMask, {
        intensity,
        frequency,
        speed,

        edgeSoftnessTexels,

        maskFlipY: this._waterMaskFlipY,
        maskUseAlpha: this._waterMaskUseAlpha,

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
        causticsDebug,

        windFoamEnabled,
        windFoamIntensity,
        windFoamTiles,
        windFoamScale,
        windFoamSpeed,
        windFoamThreshold,
        windFoamSoftness,
        windFoamStreakiness,
        windFoamDepthLo,
        windFoamDepthHi,
        windFoamColor,

        windDirX,
        windDirY,
        windSpeed: windSpeed01,
        windFoamPhase
      });
      this._sourceRegistered = true;
    } else {
      dm.updateSourceMask('water', this.waterMask);

      dm.updateSourceParams('water', {
        intensity,
        frequency,
        speed,
        edgeSoftnessTexels,
        maskFlipY: this._waterMaskFlipY,
        maskUseAlpha: this._waterMaskUseAlpha,
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
        causticsDebug,

        windFoamEnabled,
        windFoamIntensity,
        windFoamTiles,
        windFoamScale,
        windFoamSpeed,
        windFoamThreshold,
        windFoamSoftness,
        windFoamStreakiness,
        windFoamDepthLo,
        windFoamDepthHi,
        windFoamColor,

        windDirX,
        windDirY,
        windSpeed: windSpeed01,
        windFoamPhase
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

    if (dm && this._dmDebugOwned && dm.params) {
      dm.params.debugMode = this._dmPrevDebugMode;
      dm.params.debugShowMask = this._dmPrevDebugShowMask;
      this._dmDebugOwned = false;
    }

    super.dispose();
  }
}
