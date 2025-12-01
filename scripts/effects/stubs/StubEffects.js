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

export class CloudShadowsEffect extends StubEffect { constructor() { super('cloud-shadows', 'Cloud Shadows', 'atmospheric'); } }
export class TimeOfDayEffect extends StubEffect { constructor() { super('time-of-day', 'Time of Day', 'atmospheric'); } }
export class WeatherEffect extends StubEffect { constructor() { super('weather', 'Weather System', 'atmospheric'); } }
export class HeatDistortionEffect extends StubEffect { constructor() { super('heat-distortion', 'Heat Distortion', 'atmospheric'); } }
export class LightningEffect extends StubEffect { constructor() { super('lightning', 'Lightning', 'atmospheric'); } }
export class AmbientEffect extends StubEffect { constructor() { super('ambient', 'Ambient Lighting', 'atmospheric'); } }
export class CloudDepthEffect extends StubEffect { constructor() { super('cloud-depth', 'Cloud Depth', 'atmospheric'); } }

// --- Surface & Material Effects ---

export class WaterEffect extends StubEffect { constructor() { super('water', 'Water', 'water'); } }
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
