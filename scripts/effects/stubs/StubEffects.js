import { EffectBase } from '../EffectComposer.js';

/**
 * Base stub for effects to minimize boilerplate
 */
class StubEffect extends EffectBase {
  constructor(id, name, category) {
    super(id, 'effect-layer'); // specific layer might need adjustment
    this.name = name;
    this.category = category;
    this.params = {
      enabled: false,
      intensity: 0.5,
      speed: 0.1,
      scale: 1.0
    };
  }

  /**
   * @returns {Object} Control schema definition
   */
  static getControlSchema() {
    return {
      enabled: false,
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
        }
      }
    };
  }

  initialize(renderer, scene, camera) {
    // Stub initialization
  }

  update(timeInfo) {
    // Stub update
  }
}

// --- Atmospheric & Environmental Effects ---

export class TimeOfDayEffect extends StubEffect { constructor() { super('time-of-day', 'Time of Day', 'atmospheric'); } }
export class WeatherEffect extends StubEffect { constructor() { super('weather', 'Weather System', 'atmospheric'); } }
export class HeatDistortionEffect extends StubEffect { constructor() { super('heat-distortion', 'Heat Distortion', 'atmospheric'); } }
export class LightningEffect extends StubEffect { constructor() { super('lightning', 'Lightning', 'atmospheric'); } }
export class AmbientEffect extends StubEffect { constructor() { super('ambient', 'Ambient Lighting', 'atmospheric'); } }

// --- Surface & Material Effects ---

export class WaterEffect extends StubEffect {
  constructor() { super('water', 'Water', 'water'); }

  static getControlSchema() {
    return {
      enabled: false,
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
}
export class FoamEffect extends StubEffect { constructor() { super('foam', 'Foam', 'water'); } }
export class GroundGlowEffect extends StubEffect { constructor() { super('ground-glow', 'Ground Glow', 'surface'); } }
export class BiofilmEffect extends StubEffect { constructor() { super('biofilm', 'Water Splashes', 'water'); } }

// --- Object & Structure Interactions ---

export class CanopyDistortionEffect extends StubEffect { constructor() { super('canopy-distortion', 'Canopy Distortion', 'structure'); } }
export class PhysicsRopeEffect extends StubEffect { constructor() { super('physics-rope', 'Physics Rope', 'structure'); } }
export class BushTreeEffect extends StubEffect { constructor() { super('bush-tree', 'Bush & Tree', 'structure'); } }
export class OverheadEffect extends StubEffect { constructor() { super('overhead', 'Overhead Effect', 'structure'); } }

// --- Particle Systems ---

export class DustEffect extends StubEffect { constructor() { super('dust', 'Dust', 'particle'); } }
export class FireSparksEffect extends StubEffect { constructor() { super('fire-sparks', 'Fire & Sparks', 'particle'); } }
export class SteamEffect extends StubEffect { constructor() { super('steam', 'Steam', 'particle'); } }
export class MetallicGlintsEffect extends StubEffect { constructor() { super('metallic-glints', 'Metallic Glints', 'particle'); } }
export class SmellyFliesEffect extends StubEffect { constructor() { super('smelly-flies', 'Smelly Flies', 'particle'); } }

// --- Global & UI Effects ---

export class PostProcessingEffect extends StubEffect { constructor() { super('post-processing', 'Post-Processing', 'global'); } }
export class SceneTransitionsEffect extends StubEffect { constructor() { super('scene-transitions', 'Scene Transitions', 'global'); } }
export class PauseEffect extends StubEffect { constructor() { super('pause', 'Pause Effect', 'global'); } }
export class LoadingScreenEffect extends StubEffect { constructor() { super('loading-screen', 'Loading Screen', 'global'); } }
export class MapPointsEffect extends StubEffect { constructor() { super('map-points', 'Map Points', 'global'); } }
