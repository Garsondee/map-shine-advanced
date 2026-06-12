import { createLogger } from '../../core/log.js';
import Coordinates from '../../utils/coordinates.js';
import { LightingDirector } from '../../core/LightingDirector.js';
import { weatherController } from '../../core/WeatherController.js';
import {
  buildEffectSceneBoundsFromCanvas,
  sampleAuthoredOutdoorsAtWorld,
} from './water-splash-behaviors.js';
import { refreshShelterOutdoorsMaskForActiveFloor } from '../outdoors-mask-sample.js';
import { getPerspectiveElevation } from '../../foundry/elevation-context.js';
import { hasV14NativeLevels } from '../../foundry/levels-scene-flags.js';
import { VisionPolygonComputer } from '../../vision/VisionPolygonComputer.js';
import { LightMesh } from '../../scene/LightMesh.js';

const log = createLogger('CandleFlamesEffectV2');

// IMPORTANT (V2): FloorRenderBus tiles use very large renderOrder ranges
// (floorIndex * 10000 + tile sort). If candle flames keep low renderOrder
// values (~120), they draw before tiles and get overwritten, making flames
// appear invisible while glow/light flicker still works.
const CANDLE_FLAME_RENDER_ORDER = 200100;

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Matches flame shader `step(0.5, vOutdoor)` — balance folders are exclusive, not blended. */
const GLOW_BALANCE_OUTDOOR_THRESHOLD = 0.5;

const GLOW_REBUILD_PARAMS = new Set([
  'glowBucketSizePx',
  'glowMaxBuckets',
  'glowRadiusPx',
  'glowInnerRadiusScale',
  'glowNightRadiusPx',
  'glowNightInnerRadiusScale',
  'wallClipEnabled',
  'wallClipRadiusScale',
]);

/** Indoor/outdoor radius scales affect wall-clip polygons — refresh clusters + meshes only. */
const GLOW_RADIUS_BALANCE_PARAMS = new Set([
  'glowIndoorRadiusScale',
  'glowOutdoorRadiusScale',
]);

/** Intensity / cancel / night boost — live uniform sync (no wall-clip rebuild). */
const GLOW_BALANCE_PHOTOMETRY_PARAMS = new Set([
  'glowIndoorIntensityScale',
  'glowOutdoorIntensityScale',
  'glowIndoorCancelScale',
  'glowOutdoorCancelScale',
  'glowIndoorNightBoost',
  'glowOutdoorNightBoost',
]);

/** @param {import('three').WebGLRenderer|null} renderer @param {import('three').Texture|null} texture */
function _isSamplingActiveRenderTarget(renderer, texture) {
  if (!renderer || !texture) return false;
  const active = renderer.getRenderTarget?.();
  return !!(active?.texture && active.texture === texture);
}

/** Glow colour endpoints for warmth slider (0 = neutral, 1 = deep candle / torch amber). */
const GLOW_COLOR_COOL = { r: 1.0, g: 1.0, b: 1.0 };
const GLOW_COLOR_WARM = { r: 1.0, g: 0.45, b: 0.06 };

export class CandleFlamesEffectV2 {
  constructor() {
    // Keep EffectBase-compatible fields local to avoid importing EffectComposer
    // here (which causes a module cycle: EffectComposer -> FloorCompositor ->
    // CandleFlamesEffectV2 -> EffectComposer).
    this.id = 'candle-flames';
    this.layer = { order: 400, name: 'Environmental', requiresDepth: false };
    this.quality = 'low';
    this.enabled = true;
    this.isInitialized = false;

    // Candle flames are instantiated from Foundry light positions without
    // per-floor filtering. Running per-floor would render all flames in every
    // floor pass and accumulate duplicates in the scene render target.
    this.floorScope = 'global';

    this.priority = 8;

    this.params = {
      enabled: true,

      flamesEnabled: true,
      maxFlames: 20000,
      flameSizePx: 14.5,
      flameOpacity: 2,
      flameFlickerSpeed: 2.3,
      flameFlickerStrength: 0.3,
      flameSizeJitter: 0.45,
      flameFlickerSpeedJitter: 0.9,
      flameFlickerStrengthJitter: 0.76,
      flameOvality: 0,
      flameWobble: 0.2,
      flameWobbleSpeed: 9.5,
      flameWobbleNoise: 0.06,
      flameShapeDistort: 1.0,
      flameIndoorSway: 0.12,
      draftiness: 0.11,
      outdoorWindInfluence: 0.82,
      outdoorSway: 0.25,

      glowEnabled: true,
      glowBucketSizePx: 288.0,
      glowMaxBuckets: 512,
      glowRadiusPx: 514.0,
      glowInnerRadiusScale: 0.35,
      glowFalloffExponent: 1.25,
      glowEdgeSoftness: 0.88,
      glowIntensity: 0.49,
      glowWarmth: 1.0,
      glowDarknessCancel: 0.6,
      glowDarknessNightBoost: 1.1,
      glowFollowLightIntensity: true,
      glowFlickerStrength: 0.05,
      glowFlickerSpeed: 5.3,
      glowFlickerStrengthJitter: 0.24,
      glowFlickerSpeedJitter: 1.0,
      glowDayIntensityScale: 1.5,
      glowNightIntensityScale: 0.62,
      glowIndoorIntensityScale: 1,
      glowOutdoorIntensityScale: 1.83,
      glowIndoorCancelScale: 2.88,
      glowOutdoorCancelScale: 0.83,
      glowIndoorRadiusScale: 4.86,
      glowOutdoorRadiusScale: 1.45,
      glowIndoorNightBoost: 0,
      glowOutdoorNightBoost: 1.15,
      glowNightWarmth: 0.32,
      glowNightIntensity: 0,
      glowNightDarknessCancel: 2.6,
      glowNightRadiusPx: 802.0,
      glowNightInnerRadiusScale: 0.15,
      glowNightFalloffExponent: 1.7,
      glowNightEdgeSoftness: 0.52,
      glowNightFlickerStrength: 0,
      glowNightFlickerSpeed: 6.3,
      glowNightFlickerStrengthJitter: 0.78,
      glowNightFlickerSpeedJitter: 0.68,
      wallClipEnabled: true,

      autoDayNightBalance: true,
      dayIntensityScale: 1.5,
      nightIntensityScale: 4,
      dayNightCurve: 0.95,

      indoorThreshold: 0.5,
      wallClipRadiusScale: 0.3,
    };

    this.renderer = null;
    this.scene = null;
    this.camera = null;

    this._mapPointsManager = null;
    this._changeListener = null;
    this._activeLevelContext = null;

    this._lightingEffect = null;

    this._group = null;
    this._flameMesh = null;
    this._flameMaterial = null;
    this._flameGeometry = null;

    this._dummy = null;

    this._attrPhase = null;
    this._attrOutdoor = null;
    this._attrIntensity = null;
    this._attrColor = null;

    this._phaseArray = null;
    this._outdoorArray = null;
    this._intensityArray = null;
    this._colorArray = null;

    this._visionComputer = new VisionPolygonComputer();

    this._glowGroup = null;
    this._glowBuckets = new Map();
    this._clusters = [];

    this._tempColor = null;

    this._hookIds = [];
    this._needsGlowRebuild = false;
    this._lastGlowRebuildAt = -Infinity;

    this._sourceFlameCount = 0;

    /** @type {{ sx: number, syWorld: number, sw: number, sh: number }|null} */
    this._sceneBounds = null;
    this._outdoorsMaskFrameToken = 0;
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'flames',
          label: 'Flames',
          type: 'folder',
          expanded: false,
          parameters: [
            'flamesEnabled',
            'maxFlames',
            'flameSizePx',
            'flameSizeJitter',
            'flameOpacity',
            'flameFlickerSpeed',
            'flameFlickerStrength',
            'flameFlickerSpeedJitter',
            'flameFlickerStrengthJitter',
            'flameOvality',
            'flameWobble',
            'flameWobbleSpeed',
            'flameWobbleNoise',
            'flameShapeDistort',
            'flameIndoorSway',
            'draftiness',
            'outdoorWindInfluence',
            'outdoorSway'
          ]
        },
        {
          name: 'dayNight',
          label: 'Day / Night (Flames)',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: [
            'autoDayNightBalance',
            'dayIntensityScale',
            'nightIntensityScale',
            'dayNightCurve',
          ],
        },
        {
          name: 'glow',
          label: 'Glow (Gameplay Light)',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: [
            'glowEnabled',
            'glowFollowLightIntensity',
            'glowDayIntensityScale',
            'glowNightIntensityScale',
            'glowDarknessNightBoost',
            'glowBucketSizePx',
            'glowMaxBuckets',
            'wallClipEnabled',
            'wallClipRadiusScale',
          ],
        },
        {
          name: 'glow-indoor',
          label: 'Glow — Indoor Balance',
          type: 'folder',
          advanced: true,
          expanded: false,
          parameters: [
            'glowIndoorIntensityScale',
            'glowIndoorCancelScale',
            'glowIndoorRadiusScale',
            'glowIndoorNightBoost',
          ],
        },
        {
          name: 'glow-outdoor',
          label: 'Glow — Outdoor Balance',
          type: 'folder',
          expanded: true,
          parameters: [
            'glowOutdoorIntensityScale',
            'glowOutdoorCancelScale',
            'glowOutdoorRadiusScale',
            'glowOutdoorNightBoost',
          ],
        },
        {
          name: 'glow-day',
          label: 'Glow — Day Pool',
          type: 'folder',
          expanded: false,
          parameters: [
            'glowWarmth',
            'glowIntensity',
            'glowDarknessCancel',
            'glowFlickerStrength',
            'glowFlickerSpeed',
            'glowFlickerStrengthJitter',
            'glowFlickerSpeedJitter',
            'glowRadiusPx',
            'glowInnerRadiusScale',
            'glowFalloffExponent',
            'glowEdgeSoftness',
          ],
        },
        {
          name: 'glow-night',
          label: 'Glow — Night Pool',
          type: 'folder',
          advanced: true,
          expanded: true,
          parameters: [
            'glowNightWarmth',
            'glowNightIntensity',
            'glowNightDarknessCancel',
            'glowNightFlickerStrength',
            'glowNightFlickerSpeed',
            'glowNightFlickerStrengthJitter',
            'glowNightFlickerSpeedJitter',
            'glowNightRadiusPx',
            'glowNightInnerRadiusScale',
            'glowNightFalloffExponent',
            'glowNightEdgeSoftness',
          ],
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },

        flamesEnabled: { type: 'boolean', default: true, label: 'Enabled' },
        maxFlames: { type: 'slider', min: 0, max: 20000, step: 250, default: 20000, label: 'Max Flames' },
        flameSizePx: { type: 'slider', min: 1, max: 64, step: 0.5, default: 14.5, label: 'Size (px)' },
        flameSizeJitter: { type: 'slider', min: 0, max: 1.0, step: 0.01, default: 0.45, label: 'Size Jitter' },
        flameOpacity: { type: 'slider', min: 0, max: 2, step: 0.05, default: 1.2, label: 'Opacity' },
        flameFlickerSpeed: { type: 'slider', min: 0, max: 20, step: 0.25, default: 2.3, label: 'Flicker Speed' },
        flameFlickerStrength: { type: 'slider', min: 0, max: 1.5, step: 0.05, default: 0.3, label: 'Flicker Strength' },
        flameFlickerSpeedJitter: { type: 'slider', min: 0, max: 1.0, step: 0.01, default: 0.9, label: 'Flicker Speed Jitter' },
        flameFlickerStrengthJitter: { type: 'slider', min: 0, max: 1.0, step: 0.01, default: 0.76, label: 'Flicker Strength Jitter' },
        flameOvality: { type: 'slider', min: 0, max: 0.85, step: 0.01, default: 0, label: 'Ovality' },
        flameWobble: {
          type: 'slider', min: 0, max: 0.8, step: 0.01, default: 0.2, label: 'Wobble',
          tooltip: 'UV bend + tip lean. Higher = flames feel more restless.',
        },
        flameWobbleSpeed: {
          type: 'slider', min: 0, max: 12.0, step: 0.05, default: 9.5, label: 'Wobble Speed',
          tooltip: 'How fast the flame shape oscillates.',
        },
        flameWobbleNoise: {
          type: 'slider', min: 0, max: 0.5, step: 0.01, default: 0.06, label: 'Shape Chaos',
          tooltip: 'Organic pulsing of flame outline (smooth noise on radius).',
        },
        flameShapeDistort: {
          type: 'slider', min: 0, max: 2.0, step: 0.05, default: 1.0, label: 'Shape Distort',
          tooltip: 'Multiplier on UV wobble displacement.',
        },
        flameIndoorSway: {
          type: 'slider', min: 0, max: 0.25, step: 0.005, default: 0.12, label: 'Indoor Sway',
          tooltip: 'Horizontal tip sway for indoor candles (draft-like).',
        },
        draftiness: {
          type: 'slider', min: 0, max: 0.4, step: 0.01, default: 0.11, label: 'Draftiness (Indoor)',
          tooltip: 'Vertex lean from indoor air currents (stronger at flame tip).',
        },
        outdoorWindInfluence: {
          type: 'slider', min: 0, max: 1.0, step: 0.02, default: 0.82, label: 'Wind Influence (Outdoor)',
          tooltip: 'How much weather wind bends outdoor candle tips.',
        },
        outdoorSway: {
          type: 'slider', min: 0, max: 0.25, step: 0.005, default: 0.25, label: 'Outdoor Sway',
          tooltip: 'Horizontal tip sway for outdoor candles.',
        },

        autoDayNightBalance: {
          type: 'boolean',
          default: true,
          label: 'Auto Day/Night',
          tooltip: 'Scales flame sprites with scene darkness. Gameplay glow uses Glow (Gameplay Light) day/night scales.',
        },
        dayIntensityScale: {
          type: 'slider',
          min: 0,
          max: 1.5,
          step: 0.01,
          default: 0.53,
          label: 'Day Scale',
          tooltip: 'Flame sprite strength at full daylight (master darkness ≈ 0).',
        },
        nightIntensityScale: {
          type: 'slider',
          min: 0.25,
          max: 4,
          step: 0.01,
          default: 1.6,
          label: 'Night Scale',
          tooltip: 'Flame sprite multiplier at full night (master darkness ≈ 1).',
        },
        dayNightCurve: {
          type: 'slider',
          min: 0.25,
          max: 3,
          step: 0.05,
          default: 1.15,
          label: 'Darkness Curve',
          tooltip: 'Above 1 = flame sprites stay dim longer into dusk; below 1 = ramp up earlier.',
        },

        glowEnabled: { type: 'boolean', default: true, label: 'Enabled' },
        glowWarmth: {
          type: 'slider', min: 0, max: 1.0, step: 0.01, default: 1.0, label: 'Pool Warmth',
          tooltip: 'Daylight pool hue at full day. Blends toward Glow — Night Pool at darkness.',
        },
        glowIntensity: {
          type: 'slider', min: 0, max: 2.5, step: 0.01, default: 0.49, label: 'Pool Intensity',
          tooltip: 'Day flicker/intensity at full daylight.',
        },
        glowDarknessCancel: {
          type: 'slider', min: 0, max: 8, step: 0.1, default: 0.6, label: 'Darkness Cancel (HDR)',
          tooltip: 'Day HDR punch into the light buffer. Night value is in Glow — Night Pool.',
        },
        glowDarknessNightBoost: {
          type: 'slider', min: 1, max: 4, step: 0.05, default: 1.0, label: 'Night Cancel Boost',
          tooltip: 'Extra darkness-cancel strength at full scene night.',
        },
        glowFollowLightIntensity: {
          type: 'boolean', default: true, label: 'Follow Point Light Gain',
          tooltip: 'Multiply cancel strength by Lighting → Point light gain so candle pools track torch brightness.',
        },
        glowDayIntensityScale: {
          type: 'slider', min: 0, max: 2, step: 0.01, default: 0.09, label: 'Day Pool Scale',
          tooltip: 'Gameplay-light pool strength at full daylight. Candles always emit; night adds darkness-cancel on top.',
        },
        glowNightIntensityScale: {
          type: 'slider', min: 0, max: 3, step: 0.01, default: 0.66, label: 'Night Pool Scale',
          tooltip: 'Brightness multiplier at full night (master darkness ≈ 1). Does not change glow hue.',
        },
        glowIndoorIntensityScale: {
          type: 'slider', min: 0, max: 4, step: 0.01, default: 0.27, label: 'Intensity Scale',
          tooltip: 'Multiplies day/night pool intensity under roof. Outdoor candles use Glow — Outdoor Balance.',
        },
        glowIndoorCancelScale: {
          type: 'slider', min: 0, max: 4, step: 0.01, default: 0.61, label: 'Cancel Scale',
          tooltip: 'HDR darkness-cancel multiplier for indoor pools (after day/night cancel blend).',
        },
        glowIndoorRadiusScale: {
          type: 'slider', min: 0.25, max: 12, step: 0.01, default: 6, label: 'Radius Scale',
          tooltip: 'Indoor pool reach multiplier (after day/night radius blend).',
        },
        glowIndoorNightBoost: {
          type: 'slider', min: 0, max: 4, step: 0.01, default: 0, label: 'Night Boost',
          tooltip: 'Extra indoor glow at full darkness. Usually lower than outdoor — interior CC already lifts local light.',
        },
        glowOutdoorIntensityScale: {
          type: 'slider', min: 0, max: 4, step: 0.01, default: 2.0, label: 'Intensity Scale',
          tooltip: 'Multiplies day/night pool intensity in open air. Push high for torches vs midnight ToD.',
        },
        glowOutdoorCancelScale: {
          type: 'slider', min: 0, max: 4, step: 0.01, default: 1.85, label: 'Cancel Scale',
          tooltip: 'HDR darkness-cancel multiplier for outdoor pools. Primary control for bright outdoor candle rings.',
        },
        glowOutdoorRadiusScale: {
          type: 'slider', min: 0.25, max: 3, step: 0.01, default: 1.28, label: 'Radius Scale',
          tooltip: 'Outdoor pool reach multiplier — wider lit area under open sky.',
        },
        glowOutdoorNightBoost: {
          type: 'slider', min: 0, max: 4, step: 0.01, default: 1.15, label: 'Night Boost',
          tooltip: 'Extra outdoor glow at full darkness, on top of intensity/cancel scales.',
        },
        glowNightWarmth: {
          type: 'slider', min: 0, max: 1.0, step: 0.01, default: 0.75, label: 'Pool Warmth',
          tooltip: 'Night-only pool hue. Blends toward this at full darkness; day warmth is in Glow — Day Pool.',
        },
        glowNightIntensity: {
          type: 'slider', min: 0, max: 2.5, step: 0.01, default: 0.09, label: 'Pool Intensity',
          tooltip: 'Night flicker/intensity scale at full darkness.',
        },
        glowNightDarknessCancel: {
          type: 'slider', min: 0, max: 8, step: 0.1, default: 2.0, label: 'Darkness Cancel (HDR)',
          tooltip: 'Night HDR punch into the light buffer. Usually higher than the day value for midnight scenes.',
        },
        glowNightFlickerStrength: {
          type: 'slider', min: 0, max: 10.0, step: 0.05, default: 0.05, label: 'Flicker Strength',
        },
        glowNightFlickerSpeed: {
          type: 'slider', min: 0, max: 25.0, step: 0.1, default: 6.3, label: 'Flicker Speed',
        },
        glowNightFlickerStrengthJitter: {
          type: 'slider', min: 0, max: 1.0, step: 0.01, default: 0.78, label: 'Flicker Strength Jitter',
        },
        glowNightFlickerSpeedJitter: {
          type: 'slider', min: 0, max: 1.0, step: 0.01, default: 0.68, label: 'Flicker Speed Jitter',
        },
        glowNightRadiusPx: {
          type: 'slider', min: 8, max: 1200, step: 2, default: 802.0, label: 'Pool Radius (px)',
          tooltip: 'Night pool reach at full darkness. Blends from day radius as scene darkens.',
        },
        glowNightInnerRadiusScale: {
          type: 'slider', min: 0.05, max: 1.0, step: 0.01, default: 0.22, label: 'Hot Core Scale',
        },
        glowNightFalloffExponent: {
          type: 'slider', min: 0.5, max: 5.0, step: 0.05, default: 1.35, label: 'Falloff Exponent',
          tooltip: 'Night core tightness. Lower = wider soft midnight pool.',
        },
        glowNightEdgeSoftness: {
          type: 'slider', min: 0, max: 1.0, step: 0.01, default: 0.52, label: 'Pool Edge Softness',
          tooltip: 'Night rim feather in the HDR light buffer.',
        },
        glowFlickerStrength: { type: 'slider', min: 0, max: 10.0, step: 0.05, default: 0.05, label: 'Flicker Strength' },
        glowFlickerSpeed: { type: 'slider', min: 0, max: 25.0, step: 0.1, default: 5.3, label: 'Flicker Speed' },
        glowFlickerStrengthJitter: { type: 'slider', min: 0, max: 1.0, step: 0.01, default: 0.24, label: 'Flicker Strength Jitter' },
        glowFlickerSpeedJitter: { type: 'slider', min: 0, max: 1.0, step: 0.01, default: 1.0, label: 'Flicker Speed Jitter' },
        glowRadiusPx: { type: 'slider', min: 8, max: 1200, step: 2, default: 514.0, label: 'Pool Radius (px)' },
        glowInnerRadiusScale: { type: 'slider', min: 0.05, max: 1.0, step: 0.01, default: 0.35, label: 'Hot Core Scale' },
        glowFalloffExponent: {
          type: 'slider', min: 0.5, max: 5.0, step: 0.05, default: 1.25, label: 'Falloff Exponent',
          tooltip: 'Core tightness for unified radial falloff. Lower = wider soft pool; higher ≈ inverse-square hot core.',
        },
        glowEdgeSoftness: {
          type: 'slider', min: 0, max: 1.0, step: 0.01, default: 0.88, label: 'Pool Edge Softness',
          tooltip: 'Feathers the glow rim in the HDR light buffer. Drives shader attenuation + rim geometry (higher = wider, softer pool).',
        },
        glowBucketSizePx: {
          type: 'slider', min: 64, max: 2048, step: 16, default: 384.0, label: 'Bucket Size (px)',
          tooltip: 'Spatial cluster size for glow pools. Lower values improve wall clipping; large buckets merge distant candles and can bleed through walls.',
        },
        glowMaxBuckets: { type: 'slider', min: 1, max: 512, step: 1, default: 256, label: 'Max Buckets' },
        wallClipEnabled: { type: 'boolean', default: true, label: 'Wall Clip' },
        wallClipRadiusScale: { type: 'slider', min: 0.1, max: 2.0, step: 0.01, default: 0.3, label: 'Clip Radius Scale' }
      }
    };
  }

  applyParamChange(paramId, value) {
    if (this.params && Object.prototype.hasOwnProperty.call(this.params, paramId)) {
      this.params[paramId] = value;
    }

    if (paramId === 'enabled') {
      this.enabled = !!this.params.enabled;
      this._applyVisibility();
      if (this.params.enabled) {
        this._rebuildFromMapPoints();
      }
      return;
    }

    if (paramId === 'flameOpacity' && this._flameMaterial?.uniforms?.uOpacity) {
      this._flameMaterial.uniforms.uOpacity.value = this.params.flameOpacity * this._computeDayNightIntensityMul();
    }

    if (paramId === 'flameFlickerSpeed' && this._flameMaterial?.uniforms?.uFlickerSpeed) {
      this._flameMaterial.uniforms.uFlickerSpeed.value = this.params.flameFlickerSpeed;
    }

    if (paramId === 'flameFlickerStrength' && this._flameMaterial?.uniforms?.uFlickerStrength) {
      this._flameMaterial.uniforms.uFlickerStrength.value = this.params.flameFlickerStrength;
    }

    if (paramId === 'flameFlickerSpeedJitter' && this._flameMaterial?.uniforms?.uFlickerSpeedJitter) {
      this._flameMaterial.uniforms.uFlickerSpeedJitter.value = this.params.flameFlickerSpeedJitter;
    }

    if (paramId === 'flameFlickerStrengthJitter' && this._flameMaterial?.uniforms?.uFlickerStrengthJitter) {
      this._flameMaterial.uniforms.uFlickerStrengthJitter.value = this.params.flameFlickerStrengthJitter;
    }

    if (paramId === 'flameSizeJitter') {
      this._rebuildFromMapPoints();
      return;
    }

    if (paramId === 'flameOvality' && this._flameMaterial?.uniforms?.uOvality) {
      this._flameMaterial.uniforms.uOvality.value = this.params.flameOvality;
    }

    if (paramId === 'flameWobble' && this._flameMaterial?.uniforms?.uWobble) {
      this._flameMaterial.uniforms.uWobble.value = this.params.flameWobble;
    }

    if (paramId === 'flameWobbleSpeed' && this._flameMaterial?.uniforms?.uWobbleSpeed) {
      this._flameMaterial.uniforms.uWobbleSpeed.value = this.params.flameWobbleSpeed;
    }

    if (paramId === 'flameWobbleNoise' && this._flameMaterial?.uniforms?.uWobbleNoise) {
      this._flameMaterial.uniforms.uWobbleNoise.value = this.params.flameWobbleNoise;
    }

    if (paramId === 'flameShapeDistort' && this._flameMaterial?.uniforms?.uShapeDistort) {
      this._flameMaterial.uniforms.uShapeDistort.value = this.params.flameShapeDistort;
    }

    if (paramId === 'flameIndoorSway' && this._flameMaterial?.uniforms?.uIndoorSway) {
      this._flameMaterial.uniforms.uIndoorSway.value = this.params.flameIndoorSway;
    }

    if (paramId === 'draftiness' && this._flameMaterial?.uniforms?.uDraftiness) {
      this._flameMaterial.uniforms.uDraftiness.value = this.params.draftiness;
    }

    if (paramId === 'outdoorWindInfluence' && this._flameMaterial?.uniforms?.uOutdoorWindInfluence) {
      this._flameMaterial.uniforms.uOutdoorWindInfluence.value = this.params.outdoorWindInfluence;
    }

    if (paramId === 'outdoorSway' && this._flameMaterial?.uniforms?.uOutdoorSway) {
      this._flameMaterial.uniforms.uOutdoorSway.value = this.params.outdoorSway;
    }

    if (paramId === 'flamesEnabled') {
      this._setFlameCount(this.params.flamesEnabled ? this._sourceFlameCount : 0);
      return;
    }

    if (paramId === 'maxFlames') {
      this._createFlameMesh();
      if (this._group && this._flameMesh && !this._flameMesh.parent) {
        this._group.add(this._flameMesh);
      }
      this._rebuildFromMapPoints();
      return;
    }

    if (paramId === 'flameSizePx') {
      this._rebuildFromMapPoints();
      return;
    }

    if (paramId.startsWith('glow') || paramId === 'wallClipEnabled' || paramId === 'wallClipRadiusScale') {
      this._applyGlowParamChange(paramId);
    }
  }

  _applyGlowParamChange(paramId) {
    if (paramId === 'glowEnabled') {
      if (!this.params.glowEnabled) this._clearGlowBuckets();
      else this._rebuildFromMapPoints();
      this._applyVisibility();
      return;
    }

    if (paramId === 'glowFalloffExponent' || paramId === 'glowNightFalloffExponent') {
      this._applyLiveGlowMeshParams();
      return;
    }

    if (paramId === 'glowEdgeSoftness' || paramId === 'glowNightEdgeSoftness') {
      this._applyLiveGlowMeshParams();
      return;
    }

    if (paramId === 'glowWarmth' || paramId === 'glowNightWarmth') {
      return;
    }

    if (paramId === 'wallClipEnabled') {
      this._scheduleGlowRebuild();
      return;
    }

    if (paramId === 'glowBucketSizePx' || paramId === 'glowMaxBuckets') {
      this._rebuildFromMapPoints();
      return;
    }

    if (GLOW_BALANCE_PHOTOMETRY_PARAMS.has(paramId)) {
      this._applyLiveGlowBalance();
      return;
    }

    if (GLOW_RADIUS_BALANCE_PARAMS.has(paramId)) {
      this._refreshGlowClusterRadii();
      this._applyLiveGlowBalance();
      this._scheduleGlowRebuild();
      return;
    }

    if (GLOW_REBUILD_PARAMS.has(paramId)) {
      this._rebuildFromMapPoints();
    }
  }

  /**
   * Recompute per-bucket pool + wall-clip radii from day/night and indoor/outdoor balance.
   * @private
   */
  _refreshGlowClusterRadii() {
    if (!this._clusters?.length) return;
    const clipScale = Math.max(0.1, Number(this.params.wallClipRadiusScale) || 1.0);
    const darkness = LightingDirector.get().masterDarkness;
    for (const c of this._clusters) {
      if (!c) continue;
      const outdoor = Math.max(0, Math.min(1, Number(c.outdoor) ?? 1));
      const glow = this._resolveGlowParams(darkness, outdoor);
      const radiusPx = Math.max(32, glow.radiusPx * clipScale);
      c.radiusPx = radiusPx;
      c.clipRadiusPx = radiusPx;
    }
  }

  /**
   * Defer wall-clip mesh rebuild to update() — never mutate lightScene during an active _lightRT draw.
   * @private
   */
  _scheduleGlowRebuild() {
    if (this._isLightBufferPassActive()) {
      this._needsGlowRebuild = true;
      return;
    }
    this._rebuildGlowMeshes();
  }

  /** @private @returns {boolean} */
  _isLightBufferPassActive() {
    const renderer = this._lightingEffect?._lastCompositorRenderer ?? this.renderer ?? null;
    const lightTex = this._lightingEffect?._lightRT?.texture ?? null;
    return _isSamplingActiveRenderTarget(renderer, lightTex);
  }

  _applyVisibility() {
    const show = !!this.params.enabled;

    if (this._group) {
      this._group.visible = show;
    }

    if (this._flameMesh) {
      this._flameMesh.visible = show && !!this.params.flamesEnabled && (this._flameMesh.count > 0);
    }

    if (this._glowGroup) {
      this._glowGroup.visible = show && !!this.params.glowEnabled;
    }
  }

  initialize(renderer, scene, camera) {
    const THREE = window.THREE;
    if (!THREE) return;

    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    this._tempColor = new THREE.Color();
    this._dummy = new THREE.Object3D();

    this._group = new THREE.Group();
    this._group.name = 'CandleFlames';
    this._group.renderOrder = CANDLE_FLAME_RENDER_ORDER;

    this._createFlameMesh();

    if (this._flameMesh) {
      this._group.add(this._flameMesh);
    }

    if (this.scene) {
      this.scene.add(this._group);
    }

    this._glowGroup = new THREE.Group();
    this._glowGroup.name = 'CandleGlow';

    this._registerWallHooks();
    // Build once on init so candles can appear even before the next map-point
    // change notification/render wiring tick.
    this._rebuildFromMapPoints();
    this._applyVisibility();

    log.info('CandleFlamesEffect initialized');
    this.isInitialized = true;
  }

  setLightingEffect(lightingEffect) {
    this._lightingEffect = lightingEffect || null;
    this._tryAttachGlowGroup();

    this._applyVisibility();
  }

  setMapPointsSources(manager) {
    const prev = this._mapPointsManager;
    if (this._changeListener && prev) {
      prev.removeChangeListener(this._changeListener);
    }

    this._mapPointsManager = manager || null;

    this._changeListener = () => {
      this._rebuildFromMapPoints();
    };

    if (this._mapPointsManager) {
      this._mapPointsManager.addChangeListener(this._changeListener);
    }

    this._rebuildFromMapPoints();
  }

  setActiveLevelContext(context = null) {
    this._activeLevelContext = context ?? window.MapShine?.activeLevelContext ?? null;
    this._rebuildFromMapPoints();
  }

  ensureMeshesAttached(scene) {
    if (!scene || !this._group) return;

    // FloorRenderBus.populate() calls clear(), which detaches non-token scene
    // objects. Re-attach the candle group so flame sprites remain visible.
    if (this._group.parent !== scene) {
      try {
        this._group.removeFromParent();
      } catch (_) {
      }
      try {
        scene.add(this._group);
      } catch (_) {
      }
    }

    if (this._flameMesh && this._flameMesh.parent !== this._group) {
      try {
        this._group.add(this._flameMesh);
      } catch (_) {
      }
    }
  }

  update(timeInfo) {
    if (!this.params.enabled) {
      this._applyVisibility();
      return;
    }

    const THREE = window.THREE;
    if (!THREE) return;

    this._sceneBounds = buildEffectSceneBoundsFromCanvas();

    this._tryAttachGlowGroup();

    if (this._flameMaterial?.uniforms?.uTime) {
      this._flameMaterial.uniforms.uTime.value = timeInfo.elapsed;
    }

    if (this._flameMaterial?.uniforms?.uOpacity) {
      this._flameMaterial.uniforms.uOpacity.value = this.params.flameOpacity * this._computeDayNightIntensityMul();
    }

    if (this._flameMaterial?.uniforms?.uFlickerSpeed) {
      this._flameMaterial.uniforms.uFlickerSpeed.value = this.params.flameFlickerSpeed;
    }

    if (this._flameMaterial?.uniforms?.uFlickerStrength) {
      this._flameMaterial.uniforms.uFlickerStrength.value = this.params.flameFlickerStrength;
    }

    if (this._flameMaterial?.uniforms?.uFlickerSpeedJitter) {
      this._flameMaterial.uniforms.uFlickerSpeedJitter.value = this.params.flameFlickerSpeedJitter;
    }

    if (this._flameMaterial?.uniforms?.uFlickerStrengthJitter) {
      this._flameMaterial.uniforms.uFlickerStrengthJitter.value = this.params.flameFlickerStrengthJitter;
    }

    if (this._flameMaterial?.uniforms?.uOvality) {
      this._flameMaterial.uniforms.uOvality.value = this.params.flameOvality;
    }

    if (this._flameMaterial?.uniforms?.uWobble) {
      this._flameMaterial.uniforms.uWobble.value = this.params.flameWobble;
    }

    if (this._flameMaterial?.uniforms?.uWobbleSpeed) {
      this._flameMaterial.uniforms.uWobbleSpeed.value = this.params.flameWobbleSpeed;
    }

    if (this._flameMaterial?.uniforms?.uWobbleNoise) {
      this._flameMaterial.uniforms.uWobbleNoise.value = this.params.flameWobbleNoise;
    }

    if (this._flameMaterial?.uniforms?.uShapeDistort) {
      this._flameMaterial.uniforms.uShapeDistort.value = this.params.flameShapeDistort;
    }

    if (this._flameMaterial?.uniforms?.uIndoorSway) {
      this._flameMaterial.uniforms.uIndoorSway.value = this.params.flameIndoorSway;
    }

    if (this._flameMaterial?.uniforms?.uDraftiness) {
      this._flameMaterial.uniforms.uDraftiness.value = this.params.draftiness;
    }

    if (this._flameMaterial?.uniforms?.uOutdoorWindInfluence) {
      this._flameMaterial.uniforms.uOutdoorWindInfluence.value = this.params.outdoorWindInfluence;
    }

    if (this._flameMaterial?.uniforms?.uOutdoorSway) {
      this._flameMaterial.uniforms.uOutdoorSway.value = this.params.outdoorSway;
    }

    if (this._flameMaterial?.uniforms?.uWindSpeed) {
      let ws = 0.0;
      try {
        ws = Number(weatherController?.getCurrentState?.()?.windSpeed ?? weatherController?.currentState?.windSpeed ?? 0.0) || 0.0;
      } catch (_) {
        ws = 0.0;
      }
      this._flameMaterial.uniforms.uWindSpeed.value = Math.max(0.0, Math.min(1.0, ws));
    }

    if (this._flameMaterial?.uniforms?.uWindDir) {
      try {
        const state = weatherController?.getCurrentState?.() ?? weatherController?.currentState;
        const dir = state?.windDirection;
        if (dir && Number.isFinite(dir.x) && Number.isFinite(dir.y)) {
          this._flameMaterial.uniforms.uWindDir.value.set(dir.x, -dir.y);
        }
      } catch (_) {
      }
    }

    // Keep flame sprites visible in V2: floor-presence masking can resolve to
    // full-scene coverage in current post stack and zero out flame alpha.
    // Glow lighting still uses clustered light meshes and remains unchanged.
    if (this._flameMaterial?.uniforms?.uHasFloorPresenceMap !== undefined) {
      const u = this._flameMaterial.uniforms;
      u.uFloorPresenceMap.value = null;
      u.uHasFloorPresenceMap.value = 0.0;
      if (this.renderer) {
        if (!this._fpSizeVec) this._fpSizeVec = new THREE.Vector2();
        this.renderer.getDrawingBufferSize(this._fpSizeVec);
        u.uResolution.value.copy(this._fpSizeVec);
      }
    }

    if (this._needsGlowRebuild && (timeInfo.elapsed - this._lastGlowRebuildAt) > 0.12) {
      this._rebuildGlowMeshes();
      this._needsGlowRebuild = false;
      this._lastGlowRebuildAt = timeInfo.elapsed;
    }

    this._updateGlowFlicker(timeInfo);
  }

  render() {
  }

  onFloorChange(_maxFloorIndex) {
    this.setActiveLevelContext(window.MapShine?.activeLevelContext ?? null);
    this._sceneBounds = buildEffectSceneBoundsFromCanvas();
  }

  /** @private */
  _syncSceneBounds() {
    this._sceneBounds = buildEffectSceneBoundsFromCanvas();
  }

  /** @private @returns {number} */
  _resolveGlowFloorIndex() {
    try {
      const af = window.MapShine?.floorStack?.getActiveFloor?.();
      if (af && Number.isFinite(Number(af.index))) {
        return Math.max(0, Math.floor(Number(af.index)));
      }
    } catch (_) {}
    return 0;
  }

  /**
   * Authored _Outdoors at Three world XY (per-floor compositor mask, not WeatherController roof cache).
   * @private
   * @param {number} worldX
   * @param {number} worldY
   * @returns {number} 0..1 outdoors strength
   */
  _sampleGlowOutdoorAtWorld(worldX, worldY) {
    const bounds = this._sceneBounds ?? buildEffectSceneBoundsFromCanvas();
    const raw = sampleAuthoredOutdoorsAtWorld(
      this._resolveGlowFloorIndex(),
      worldX,
      worldY,
      bounds,
      this._outdoorsMaskFrameToken,
      this._activeLevelContext ?? window.MapShine?.activeLevelContext ?? null,
    );
    if (raw == null || !Number.isFinite(raw)) return 1.0;
    return clamp01(raw);
  }

  dispose() {
    try {
      if (this._mapPointsManager && this._changeListener) {
        this._mapPointsManager.removeChangeListener(this._changeListener);
      }
    } catch (_) {
    }

    for (const [hook, id] of this._hookIds) {
      try {
        Hooks.off(hook, id);
      } catch (_) {
      }
    }
    this._hookIds.length = 0;

    this._clearGlowBuckets();

    try {
      this._glowGroup?.removeFromParent?.();
    } catch (_) {
    }

    try {
      if (this._flameMesh) {
        this._flameMesh.removeFromParent();
      }
      if (this._flameGeometry) this._flameGeometry.dispose();
      if (this._flameMaterial) this._flameMaterial.dispose();
    } catch (_) {
    }

    try {
      this._group?.removeFromParent?.();
    } catch (_) {
    }

    this._flameMesh = null;
    this._flameGeometry = null;
    this._flameMaterial = null;
    this._group = null;
    this._glowGroup = null;
    this.isInitialized = false;
  }

  _registerWallHooks() {
    const safeOn = (hook, fn) => {
      try {
        const id = Hooks.on(hook, fn);
        this._hookIds.push([hook, id]);
      } catch (_) {
      }
    };

    const onWallChanged = () => {
      this._needsGlowRebuild = true;
    };

    safeOn('createWall', onWallChanged);
    safeOn('updateWall', onWallChanged);
    safeOn('deleteWall', onWallChanged);
  }

  _tryAttachGlowGroup() {
    const lightScene = this._lightingEffect?.lightScene;
    if (!lightScene || !this._glowGroup) return;

    if (this._glowGroup.parent !== lightScene) {
      try {
        this._glowGroup.removeFromParent();
      } catch (_) {
      }
      try {
        lightScene.add(this._glowGroup);
      } catch (_) {
      }
    }
  }

  _hash2(x, y) {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
    return s - Math.floor(s);
  }

  _getGroundZ() {
    const sceneComposer = window.MapShine?.sceneComposer;
    if (sceneComposer && typeof sceneComposer.groundZ === 'number') {
      return sceneComposer.groundZ;
    }
    return 1000;
  }

  /**
   * Darkness-driven scale for flame sprites only.
   * @returns {number}
   */
  _computeDayNightIntensityMul() {
    if (!this.params.autoDayNightBalance) return 1.0;

    const darkness = clamp01(LightingDirector.get().masterDarkness);
    const dayFloor = 0.55;
    const day = Math.max(dayFloor, Math.max(0, Number(this.params.dayIntensityScale) || 0));
    const night = Math.max(day, Math.max(0, Number(this.params.nightIntensityScale) || 0));
    const curve = Math.max(0.05, Number(this.params.dayNightCurve) || 1);
    const t = Math.pow(darkness, curve);
    return day + (night - day) * t;
  }

  /** @private @param {number} [darkness] */
  _blendGlowDayNightParam(dayKey, nightKey, fallback = 0, darkness = null) {
    const t = clamp01(Number.isFinite(Number(darkness))
      ? Number(darkness)
      : LightingDirector.get().masterDarkness);
    const dayRaw = Number(this.params[dayKey]);
    const day = Number.isFinite(dayRaw) ? dayRaw : fallback;
    const nightRaw = Number(this.params[nightKey]);
    const night = Number.isFinite(nightRaw) ? nightRaw : day;
    return day + (night - day) * t;
  }

  /**
   * Classify a pool for Indoor vs Outdoor Balance folders (binary, not roof-mask lerp).
   * @private
   * @param {number} outdoor01
   * @returns {0|1}
   */
  _snapGlowBalanceOutdoor(outdoor01) {
    return clamp01(Number(outdoor01) || 0) > GLOW_BALANCE_OUTDOOR_THRESHOLD ? 1.0 : 0.0;
  }

  /** @private @param {number} outdoor01 */
  _blendGlowIndoorOutdoorParam(indoorKey, outdoorKey, fallback = 1.0, outdoor01 = 0.5) {
    const o = clamp01(Number(outdoor01) || 0);
    const indoorRaw = Number(this.params[indoorKey]);
    const indoor = Number.isFinite(indoorRaw) ? indoorRaw : fallback;
    const outdoorRaw = Number(this.params[outdoorKey]);
    const outdoor = Number.isFinite(outdoorRaw) ? outdoorRaw : fallback;
    return indoor + (outdoor - indoor) * o;
  }

  /**
   * Effective gameplay-light pool params blended by master darkness (day → night)
   * and roof mask (indoor → outdoor).
   * @param {number} [darkness]
   * @param {number|null} [outdoor01]
   * @returns {object}
   * @private
   */
  _resolveGlowParams(darkness = null, outdoor01 = null) {
    const t = clamp01(Number.isFinite(Number(darkness))
      ? Number(darkness)
      : LightingDirector.get().masterDarkness);
    const base = {
      t,
      warmth: clamp01(this._blendGlowDayNightParam('glowWarmth', 'glowNightWarmth', 1.0, t)),
      intensity: Math.max(0, this._blendGlowDayNightParam('glowIntensity', 'glowNightIntensity', 0.42, t)),
      cancel: Math.max(0, this._blendGlowDayNightParam('glowDarknessCancel', 'glowNightDarknessCancel', 3.0, t)),
      radiusPx: Math.max(32, this._blendGlowDayNightParam('glowRadiusPx', 'glowNightRadiusPx', 172.0, t)),
      innerScale: Math.max(0.05, Math.min(1, this._blendGlowDayNightParam(
        'glowInnerRadiusScale',
        'glowNightInnerRadiusScale',
        0.2,
        t,
      ))),
      falloffExponent: Math.min(5.0, Math.max(0.5, this._blendGlowDayNightParam(
        'glowFalloffExponent',
        'glowNightFalloffExponent',
        2.0,
        t,
      ))),
      edgeSoftness: Math.max(0, Math.min(1.0, this._blendGlowDayNightParam(
        'glowEdgeSoftness',
        'glowNightEdgeSoftness',
        0.28,
        t,
      ))),
      flickerStrength: Math.max(0, this._blendGlowDayNightParam(
        'glowFlickerStrength',
        'glowNightFlickerStrength',
        2.25,
        t,
      )),
      flickerSpeed: Math.max(0, this._blendGlowDayNightParam('glowFlickerSpeed', 'glowNightFlickerSpeed', 6.0, t)),
      flickerStrengthJitter: clamp01(this._blendGlowDayNightParam(
        'glowFlickerStrengthJitter',
        'glowNightFlickerStrengthJitter',
        0.75,
        t,
      )),
      flickerSpeedJitter: clamp01(this._blendGlowDayNightParam(
        'glowFlickerSpeedJitter',
        'glowNightFlickerSpeedJitter',
        0.65,
        t,
      )),
    };

    if (outdoor01 == null || !Number.isFinite(Number(outdoor01))) return base;

    const balanceOutdoor = this._snapGlowBalanceOutdoor(outdoor01);
    const intensityScale = Math.max(0, this._blendGlowIndoorOutdoorParam(
      'glowIndoorIntensityScale',
      'glowOutdoorIntensityScale',
      1.0,
      balanceOutdoor,
    ));
    const cancelScale = Math.max(0, this._blendGlowIndoorOutdoorParam(
      'glowIndoorCancelScale',
      'glowOutdoorCancelScale',
      1.0,
      balanceOutdoor,
    ));
    const radiusScale = Math.max(0.25, this._blendGlowIndoorOutdoorParam(
      'glowIndoorRadiusScale',
      'glowOutdoorRadiusScale',
      1.0,
      balanceOutdoor,
    ));

    return {
      ...base,
      intensity: base.intensity * intensityScale,
      cancel: base.cancel * cancelScale,
      radiusPx: Math.max(32, base.radiusPx * radiusScale),
    };
  }

  /** Push current darkness-blended falloff/edge to all glow meshes (UI tweak). @private */
  _applyLiveGlowMeshParams() {
    this._applyLiveGlowBalance({ falloffEdgeOnly: true });
  }

  /**
   * Push indoor/outdoor + day/night glow photometry to all pools (slider preview).
   * @param {{ falloffEdgeOnly?: boolean }} [opts]
   * @private
   */
  _applyLiveGlowBalance(opts = {}) {
    if (!this.params.glowEnabled || !this._glowBuckets.size) return;

    const falloffEdgeOnly = opts.falloffEdgeOnly === true;
    const dayNightMul = this._computeGlowDayNightIntensityMul();
    const clipScale = Math.max(0.1, Number(this.params.wallClipRadiusScale) || 1.0);

    for (const entry of this._glowBuckets.values()) {
      const lm = entry?.lightMesh;
      const u = lm?.material?.uniforms;
      if (!u?.uColor?.value) continue;

      const outdoor = entry.outdoor ?? 1.0;
      const glow = this._resolveGlowParams(null, outdoor);
      const radiusPx = Math.max(32, glow.radiusPx * clipScale);
      const innerRadiusPx = Math.max(1, radiusPx * glow.innerScale);

      lm.setOuterRadiusPx?.(radiusPx);
      lm.setInnerRadiusPx?.(innerRadiusPx);
      lm.setFalloffExponent?.(glow.falloffExponent);
      lm.setEdgeSoftness?.(glow.edgeSoftness);

      if (falloffEdgeOnly) continue;

      const indoorMul = this._computeGlowIndoorNightBoost(outdoor);
      const outdoorMul = this._computeGlowOutdoorNightBoost(outdoor);
      const visualMul = Math.max(
        0.0,
        glow.intensity
          * Math.max(0.25, entry.intensity)
          * dayNightMul
          * indoorMul
          * outdoorMul
      );

      const glowColor = this._computeGlowColor(glow.warmth);
      u.uColor.value.setRGB(glowColor.r, glowColor.g, glowColor.b);
      lm.setAchromaticRgb?.(false);

      const emissionGain = this._computeGlowEmissionGain(visualMul, glow.cancel);
      if (typeof lm.setEmissionGain === 'function') {
        lm.setEmissionGain(emissionGain);
      } else if (u.uEmissionGain) {
        u.uEmissionGain.value = emissionGain;
      }
    }
  }

  _computeGlowDayNightIntensityMul() {
    const darkness = clamp01(LightingDirector.get().masterDarkness);
    const dayFloor = 0.55;
    const day = Math.max(dayFloor, Math.max(0, Number(this.params.glowDayIntensityScale) || 0));
    const night = Math.max(day, Math.max(0, Number(this.params.glowNightIntensityScale) || 0));
    return day + (night - day) * darkness;
  }

  /**
   * HDR emission gain for glow buckets (compose alpha → darkness punch + direct light).
   * @param {number} visualMul - Per-bucket flicker / intensity / day-night colour scale.
   * @param {number} [cancelOverride]
   * @returns {number}
   */
  _computeGlowEmissionGain(visualMul, cancelOverride = null) {
    const cancel = Math.max(0, Number(cancelOverride ?? this.params.glowDarknessCancel) || 0);
    if (cancel <= 0) return 0;

    let lightMul = 1.0;
    if (this.params.glowFollowLightIntensity) {
      const li = Number(this._lightingEffect?.params?.lightIntensity);
      lightMul = Number.isFinite(li) ? Math.max(0.25, li) : 2.0;
    }

    const darkness = clamp01(LightingDirector.get().masterDarkness);
    const nightBoost = Math.max(1, Number(this.params.glowDarknessNightBoost) || 1);
    const nightMul = 1.0 + darkness * (nightBoost - 1.0);

    const vis = Math.max(0, Number(visualMul) || 0);
    return cancel * lightMul * nightMul * vis;
  }

  /** Linear RGB glow tint from warmth slider (0 = neutral, 1 = candle amber). */
  _computeGlowColor(warmth = this.params.glowWarmth) {
    const w = clamp01(Number(warmth) || 0);
    return {
      r: GLOW_COLOR_COOL.r + (GLOW_COLOR_WARM.r - GLOW_COLOR_COOL.r) * w,
      g: GLOW_COLOR_COOL.g + (GLOW_COLOR_WARM.g - GLOW_COLOR_COOL.g) * w,
      b: GLOW_COLOR_COOL.b + (GLOW_COLOR_WARM.b - GLOW_COLOR_COOL.b) * w,
    };
  }

  /** Extra glow indoors at night (uses per-bucket roof mask). */
  _computeGlowIndoorNightBoost(outdoor01) {
    const legacy = Number(this.params.indoorNightBoost);
    const boost = Math.max(0, Number(this.params.glowIndoorNightBoost ?? legacy) || 0);
    if (boost <= 0) return 1.0;
    const darkness = clamp01(LightingDirector.get().masterDarkness);
    const indoor = 1.0 - this._snapGlowBalanceOutdoor(outdoor01);
    return 1.0 + boost * indoor * darkness;
  }

  /** Extra glow outdoors at night (uses per-bucket roof mask). */
  _computeGlowOutdoorNightBoost(outdoor01) {
    const boost = Math.max(0, Number(this.params.glowOutdoorNightBoost) || 0);
    if (boost <= 0) return 1.0;
    const darkness = clamp01(LightingDirector.get().masterDarkness);
    const outdoor = this._snapGlowBalanceOutdoor(outdoor01);
    return 1.0 + boost * outdoor * darkness;
  }

  /** Clip glow to physical wall segments (blocks light-pass-through / window walls). */
  _buildGlowWallClipOptions() {
    const opts = {
      blockGeometry: true,
      // Smooth glow pool boundary (default VisionPolygonComputer uses 32).
      circleSegments: 96,
    };
    try {
      const pad = window.MapShine?.lightingEffect?.params?.wallPaddingPx;
      if (typeof pad === 'number' && isFinite(pad) && pad > 0) {
        opts.wallPaddingPx = Math.max(0, pad);
      }
      if (hasV14NativeLevels(canvas?.scene)) {
        const pe = getPerspectiveElevation();
        if (Number.isFinite(pe?.losHeight)) {
          opts.elevation = pe.losHeight;
        }
      }
    } catch (_) {
    }
    return opts;
  }

  _createFlameMesh() {
    const THREE = window.THREE;
    if (!THREE) return;

    if (this._flameMesh) {
      try {
        this._flameMesh.removeFromParent();
      } catch (_) {
      }
      this._flameMesh = null;
    }

    if (this._flameGeometry) {
      try {
        this._flameGeometry.dispose();
      } catch (_) {
      }
      this._flameGeometry = null;
    }

    if (this._flameMaterial) {
      try {
        this._flameMaterial.dispose();
      } catch (_) {
      }
      this._flameMaterial = null;
    }

    const geometry = new THREE.PlaneGeometry(1, 1, 1, 1);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0.0 },
        uOpacity: { value: this.params.flameOpacity },
        uFlickerSpeed: { value: this.params.flameFlickerSpeed },
        uFlickerStrength: { value: this.params.flameFlickerStrength },
        uFlickerSpeedJitter: { value: this.params.flameFlickerSpeedJitter },
        uFlickerStrengthJitter: { value: this.params.flameFlickerStrengthJitter },
        uOvality: { value: this.params.flameOvality },
        uWobble: { value: this.params.flameWobble },
        uWobbleSpeed: { value: this.params.flameWobbleSpeed },
        uWobbleNoise: { value: this.params.flameWobbleNoise },
        uShapeDistort: { value: this.params.flameShapeDistort },
        uIndoorSway: { value: this.params.flameIndoorSway },
        uDraftiness: { value: this.params.draftiness },
        uOutdoorWindInfluence: { value: this.params.outdoorWindInfluence },
        uOutdoorSway: { value: this.params.outdoorSway },
        uWindSpeed: { value: 0.0 },
        uWindDir: { value: new THREE.Vector2(1.0, 0.0) },
        // Floor-presence gate: screen-space RT (layer 23) where R=1 beneath
        // the current floor's opaque tiles. Occludes below-floor candle flames
        // so flames from floor 0 don't render through solid floor-1 tiles.
        uFloorPresenceMap:    { value: null },
        uHasFloorPresenceMap: { value: 0.0 },
        uResolution:          { value: new THREE.Vector2(1.0, 1.0) },
      },
      vertexShader: `
        varying vec2 vUv;
        varying float vPhase;
        varying float vOutdoor;
        varying float vIntensity;
        varying vec3 vColor;

        uniform float uTime;
        uniform float uDraftiness;
        uniform float uOutdoorWindInfluence;
        uniform float uWindSpeed;
        uniform vec2 uWindDir;

        attribute float aPhase;
        attribute float aOutdoor;
        attribute float aIntensity;
        attribute vec3 aColor;

        void main() {
          vUv = uv;
          vPhase = aPhase;
          vOutdoor = aOutdoor;
          vIntensity = aIntensity;
          vColor = aColor;

          vec4 mvPosition = vec4(position, 1.0);
          #ifdef USE_INSTANCING
            mvPosition = instanceMatrix * mvPosition;
          #endif

          vec2 windDir = uWindDir;
          float windLen = length(windDir);
          if (windLen > 1e-4) windDir /= windLen;

          vec2 draftDir = vec2(sin(vPhase * 9.17), cos(vPhase * 6.11));
          float draftLen = length(draftDir);
          if (draftLen > 1e-4) draftDir /= draftLen;

          float outdoorMask = step(0.5, vOutdoor);
          float indoorMask = 1.0 - outdoorMask;

          float wiggle = 0.55 + 0.45 * sin(uTime * (2.1 + 0.9 * uWindSpeed) + vPhase * 6.2831);
          float swayOutdoor = outdoorMask * uOutdoorWindInfluence * uWindSpeed * wiggle;
          float swayIndoor = indoorMask * uDraftiness * wiggle;

          float top = clamp(vUv.y, 0.0, 1.0);
          vec2 offset = (windDir * swayOutdoor + draftDir * swayIndoor) * (top * top);
          mvPosition.xy += offset;

          mvPosition = modelViewMatrix * mvPosition;
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        varying float vPhase;
        varying float vOutdoor;
        varying float vIntensity;
        varying vec3 vColor;

        uniform float uTime;
        uniform float uOpacity;
        uniform float uFlickerSpeed;
        uniform float uFlickerStrength;
        uniform float uFlickerSpeedJitter;
        uniform float uFlickerStrengthJitter;
        uniform float uOutdoorSway;
        uniform float uIndoorSway;
        uniform float uOvality;
        uniform float uWobble;
        uniform float uWobbleSpeed;
        uniform float uWobbleNoise;
        uniform float uShapeDistort;
        uniform float uWindSpeed;
        uniform sampler2D uFloorPresenceMap;
        uniform float uHasFloorPresenceMap;
        uniform vec2 uResolution;

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 78.233);
          return fract(p.x * p.y);
        }

        float smoothNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          float a = hash21(i);
          float b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0));
          float d = hash21(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
        }

        void main() {
          vec2 uv = vUv;

          float sway = 0.0;
          if (vOutdoor > 0.5) {
            sway = uOutdoorSway * (sin(uTime * 1.7 + vPhase * 6.2831) * 0.5 + sin(uTime * 2.9 + vPhase * 9.1) * 0.5);
          } else {
            sway = uIndoorSway * (sin(uTime * 1.4 + vPhase * 5.1) * 0.5 + sin(uTime * 2.2 + vPhase * 8.3) * 0.5);
          }
          uv.x += sway;

          vec2 p = uv - vec2(0.5);

          float oval = clamp(uOvality, 0.0, 0.95);
          p.x *= (1.0 + oval);
          p.y *= (1.0 - 0.55 * oval);

          float wobbleSpeed = uWobbleSpeed;
          float wTime = uTime * wobbleSpeed + vPhase * 19.7;
          float wAmp = uWobble * (0.35 + 0.65 * (0.5 + 0.5 * uWindSpeed));

          vec2 wob = vec2(
            sin(wTime * 1.31 + p.y * 6.0),
            sin(wTime * 1.77 + p.x * 5.0)
          );
          float distort = max(0.0, uShapeDistort);
          p += wob * wAmp * distort * (0.35 + 0.65 * p.y);
          float r = length(p) * 2.0;

          // Use vPhase (stable per candle) to vary flicker per-instance.
          float rand01 = fract(sin(vPhase * 43758.5453) * 43758.5453);
          float rand01b = fract(sin((vPhase + 0.37) * 31742.2341) * 9831.11);

          float sj = clamp(uFlickerSpeedJitter, 0.0, 1.0);
          float stj = clamp(uFlickerStrengthJitter, 0.0, 1.0);

          float speedVar = mix(1.0 - sj, 1.0 + sj, rand01);
          float strengthVar = mix(1.0 - stj, 1.0 + stj, rand01b);

          float flickerSpeed = uFlickerSpeed * speedVar;
          float flickerStrength = uFlickerStrength * strengthVar;

          float t = uTime * flickerSpeed + vPhase * 25.0;
          float noiseAmp = clamp(uWobbleNoise, 0.0, 0.5);
          float n = smoothNoise(p * 6.0 + vec2(t * 0.15, t * 0.11));
          float wobble = mix(1.0 - noiseAmp, 1.0 + noiseAmp, n);
          r *= wobble;

          float alpha = smoothstep(1.0, 0.0, r);

          float core = smoothstep(0.35, 0.0, r);

          vec3 hot = vec3(1.0, 0.95, 0.85);
          vec3 warm = vec3(1.0, 0.65, 0.18);
          vec3 cool = vec3(1.0, 0.18, 0.02);

          vec3 col = mix(cool, warm, 1.0 - r);
          col = mix(col, hot, core);

          col *= vColor;

          float flickerBase = 0.9 + 0.1 * sin(t * 0.7 + vPhase * 2.0);
          float flickerShape = sin(t) * 0.65 + sin(t * 1.73 + 2.0) * 0.35;
          float flicker = flickerBase + flickerStrength * 0.35 * flickerShape;
          flicker = max(0.55, flicker);
          float finalAlpha = alpha * uOpacity * clamp(vIntensity, 0.0, 3.0) * flicker;

          // Floor-presence gate: occlude candle flames under current-floor
          // solid tiles (layer-23 floorPresenceTarget, screen-space).
          if (uHasFloorPresenceMap > 0.5) {
            vec2 fpUv = gl_FragCoord.xy / max(uResolution, vec2(1.0));
            finalAlpha *= (1.0 - texture2D(uFloorPresenceMap, fpUv).r);
          }

          if (finalAlpha <= 0.001) discard;

          gl_FragColor = vec4(col, finalAlpha);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true
    });

    material.toneMapped = false;

    this._phaseArray = new Float32Array(this.params.maxFlames);
    this._outdoorArray = new Float32Array(this.params.maxFlames);
    this._intensityArray = new Float32Array(this.params.maxFlames);
    this._colorArray = new Float32Array(this.params.maxFlames * 3);

    this._attrPhase = new THREE.InstancedBufferAttribute(this._phaseArray, 1);
    this._attrOutdoor = new THREE.InstancedBufferAttribute(this._outdoorArray, 1);
    this._attrIntensity = new THREE.InstancedBufferAttribute(this._intensityArray, 1);
    this._attrColor = new THREE.InstancedBufferAttribute(this._colorArray, 3);

    this._attrPhase.setUsage(THREE.DynamicDrawUsage);
    this._attrOutdoor.setUsage(THREE.DynamicDrawUsage);
    this._attrIntensity.setUsage(THREE.DynamicDrawUsage);
    this._attrColor.setUsage(THREE.DynamicDrawUsage);

    geometry.setAttribute('aPhase', this._attrPhase);
    geometry.setAttribute('aOutdoor', this._attrOutdoor);
    geometry.setAttribute('aIntensity', this._attrIntensity);
    geometry.setAttribute('aColor', this._attrColor);

    const mesh = new THREE.InstancedMesh(geometry, material, this.params.maxFlames);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.renderOrder = CANDLE_FLAME_RENDER_ORDER;

    this._flameGeometry = geometry;
    this._flameMaterial = material;
    this._flameMesh = mesh;
  }

  _rebuildFromMapPoints() {
    if (!this._mapPointsManager) {
      this._sourceFlameCount = 0;
      this._setFlameCount(0);
      this._clusters.length = 0;
      this._clearGlowBuckets();
      return;
    }

    const groups = (typeof this._mapPointsManager.getGroupsByEffectForContext === 'function')
      ? (this._mapPointsManager.getGroupsByEffectForContext('candleFlame', this._activeLevelContext) || [])
      : (this._mapPointsManager.getGroupsByEffect('candleFlame') || []);
    const points = [];
    for (const g of groups) {
      if (!g?.points?.length) continue;
      const intensity = (g.emission && typeof g.emission.intensity === 'number') ? g.emission.intensity : 1.0;
      for (let pointIndex = 0; pointIndex < g.points.length; pointIndex++) {
        const p = g.points[pointIndex];
        if (!p) continue;
        if (typeof this._mapPointsManager.isGroupPointEnabled === 'function'
          && !this._mapPointsManager.isGroupPointEnabled(g.id, pointIndex)) {
          continue;
        }
        points.push({ x: p.x, y: p.y, intensity });
      }
    }

    if (points.length === 0) {
      this._sourceFlameCount = 0;
      this._setFlameCount(0);
      this._clusters.length = 0;
      this._clearGlowBuckets();
      return;
    }

    this._syncSceneBounds();
    try { refreshShelterOutdoorsMaskForActiveFloor(); } catch (_) {}

    const groundZ = this._getGroundZ();

    const maxFlames = Math.max(0, this.params.maxFlames | 0);
    const flameSize = Math.max(1, this.params.flameSizePx);
    const sizeJitter = Math.max(0.0, Math.min(1.0, Number(this.params.flameSizeJitter) || 0.0));

    const baseR = 1.0;
    const baseG = 0.85;
    const baseB = 0.55;

    const buckets = new Map();
    const bucketSize = Math.max(32, this.params.glowBucketSizePx);

    let written = 0;

    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      const wx = pt.x;
      const wy = pt.y;

      const outdoor = this._sampleGlowOutdoorAtWorld(wx, wy);

      const bx = Math.floor(wx / bucketSize);
      const by = Math.floor(wy / bucketSize);
      const key = `${bx},${by}`;

      let b = buckets.get(key);
      if (!b) {
        b = { sumX: 0, sumY: 0, sumI: 0, sumOutdoor: 0, minOutdoor: 1.0, count: 0 };
        buckets.set(key, b);
      }
      b.sumX += wx;
      b.sumY += wy;
      b.sumI += pt.intensity;
      b.sumOutdoor += outdoor;
      b.minOutdoor = Math.min(b.minOutdoor, outdoor);
      b.count += 1;

      if (written < maxFlames) {
        const phase = this._hash2(wx, wy);

        // Stable per-candle size variance (avoids synchronous ΓÇ£cloneΓÇ¥ look).
        const sizeRand = Math.sin((phase + 0.13) * 1000.0) * 43758.5453;
        const size01 = sizeRand - Math.floor(sizeRand);
        const sizeVar = 1.0 + (size01 * 2.0 - 1.0) * sizeJitter;
        const s = Math.max(1.0, flameSize * Math.max(0.2, sizeVar));

        this._dummy.position.set(wx, wy, groundZ + 3.5);
        this._dummy.rotation.set(0, 0, phase * Math.PI * 2);
        this._dummy.scale.set(s, s, 1);
        this._dummy.updateMatrix();
        this._flameMesh.setMatrixAt(written, this._dummy.matrix);

        this._phaseArray[written] = phase;
        this._outdoorArray[written] = outdoor;
        // Keep a small minimum so flames remain visible even when map-point
        // emission intensity is authored as 0 (glow already uses a similar floor).
        this._intensityArray[written] = Math.max(0.25, Number(pt.intensity) || 0);

        const cIdx = written * 3;
        this._colorArray[cIdx] = baseR;
        this._colorArray[cIdx + 1] = baseG;
        this._colorArray[cIdx + 2] = baseB;

        written++;
      }
    }

    this._sourceFlameCount = written;
    this._setFlameCount(this.params.flamesEnabled ? written : 0);

    this._clusters.length = 0;

    const maxBuckets = Math.max(1, this.params.glowMaxBuckets | 0);
    const list = [];
    for (const [key, b] of buckets.entries()) {
      if (!b || b.count <= 0) continue;
      list.push({ key, ...b });
    }

    list.sort((a, b) => (b.sumI - a.sumI) || (b.count - a.count));

    const take = Math.min(list.length, maxBuckets);

    const clipRadiusScale = Math.max(0.1, Number(this.params.wallClipRadiusScale) || 1.0);

    for (let i = 0; i < take; i++) {
      const b = list[i];
      const cxWorld = b.sumX / b.count;
      const cyWorld = b.sumY / b.count;
      const outdoorAtCenter = this._sampleGlowOutdoorAtWorld(cxWorld, cyWorld);
      const outdoorForGlow = Math.min(
        Number.isFinite(b.minOutdoor) ? b.minOutdoor : outdoorAtCenter,
        outdoorAtCenter,
      );
      const phase = this._hash2(cxWorld, cyWorld);

      const intensity = b.sumI / Math.max(1, b.count);
      const glow = this._resolveGlowParams(null, outdoorForGlow);
      const radiusPx = Math.max(32, glow.radiusPx * clipRadiusScale);
      const clipRadiusPx = radiusPx;

      const foundryCenter = Coordinates.toFoundry(cxWorld, cyWorld);

      this._clusters.push({
        key: b.key,
        cxWorld,
        cyWorld,
        cxFoundry: foundryCenter.x,
        cyFoundry: foundryCenter.y,
        radiusPx,
        clipRadiusPx,
        intensity,
        phase,
        outdoor: outdoorForGlow,
        color: this._computeGlowColor(glow.warmth),
      });
    }

    this._rebuildGlowMeshes();
  }

  _setFlameCount(n) {
    const THREE = window.THREE;
    if (!THREE || !this._flameMesh) return;

    const count = Math.max(0, Math.min(this.params.maxFlames | 0, n | 0));

    this._flameMesh.count = count;
    this._flameMesh.visible = !!this.params.flamesEnabled && count > 0;

    if (this._flameMesh.instanceMatrix) {
      this._flameMesh.instanceMatrix.needsUpdate = true;
    }

    if (this._attrPhase) this._attrPhase.needsUpdate = true;
    if (this._attrOutdoor) this._attrOutdoor.needsUpdate = true;
    if (this._attrIntensity) this._attrIntensity.needsUpdate = true;
    if (this._attrColor) this._attrColor.needsUpdate = true;
  }

  _clearGlowBuckets() {
    if (!this._glowGroup) return;

    for (const entry of this._glowBuckets.values()) {
      try {
        entry?.lightMesh?.dispose?.();
      } catch (_) {
      }

      try {
        entry?.lightMesh?.mesh?.removeFromParent?.();
      } catch (_) {
      }
    }

    this._glowBuckets.clear();

    try {
      while (this._glowGroup.children.length) {
        const c = this._glowGroup.children.pop();
        c?.removeFromParent?.();
      }
    } catch (_) {
    }
  }

  /** Refresh glow pool outdoor classification + meshes after _Outdoors CPU decode updates. */
  onOutdoorsMaskUpdated() {
    if (!this.params.glowEnabled || !this._clusters?.length) return;
    this._syncSceneBounds();
    for (const c of this._clusters) {
      if (!c) continue;
      c.outdoor = this._sampleGlowOutdoorAtWorld(c.cxWorld, c.cyWorld);
    }
    this._rebuildGlowMeshes();
  }

  _rebuildGlowMeshes() {
    if (this._isLightBufferPassActive()) {
      this._needsGlowRebuild = true;
      return;
    }

    if (!this.params.glowEnabled) {
      this._clearGlowBuckets();
      return;
    }

    this._tryAttachGlowGroup();

    if (!this._glowGroup?.parent) {
      this._clearGlowBuckets();
      return;
    }

    const lightScene = this._lightingEffect?.lightScene ?? null;
    const glowGroup = this._glowGroup;
    let detached = false;
    if (lightScene && glowGroup?.parent === lightScene) {
      try {
        lightScene.remove(glowGroup);
        detached = true;
      } catch (_) {
      }
    }

    this._clearGlowBuckets();

    const THREE = window.THREE;
    if (!THREE) return;

    const walls = canvas?.walls?.placeables ?? [];

    const d = canvas?.dimensions;
    const sceneX = d?.sceneX ?? 0;
    const sceneY = d?.sceneY ?? 0;
    const sceneW = d?.sceneWidth ?? d?.width ?? 1;
    const sceneH = d?.sceneHeight ?? d?.height ?? 1;

    const sceneBounds = { x: sceneX, y: sceneY, width: sceneW, height: sceneH };
    const wallClipOptions = this._buildGlowWallClipOptions();

    for (const c of this._clusters) {
      if (!c) continue;

      const outdoor = Math.max(0, Math.min(1, Number(c.outdoor) ?? 1));
      const glow = this._resolveGlowParams(null, outdoor);
      const cxFoundry = c.cxFoundry;
      const cyFoundry = c.cyFoundry;
      const clipScale = Math.max(0.1, Number(this.params.wallClipRadiusScale) || 1.0);
      const radiusPx = Math.max(32, glow.radiusPx * clipScale);
      const clipRadiusPx = radiusPx;

      let foundryPoly = null;
      if (this.params.wallClipEnabled) {
        try {
          foundryPoly = this._visionComputer.compute(
            { x: cxFoundry, y: cyFoundry },
            clipRadiusPx,
            walls,
            sceneBounds,
            wallClipOptions
          );
        } catch (_) {
          foundryPoly = null;
        }
      }

      const centerWorld = new THREE.Vector2(c.cxWorld, c.cyWorld);

      let worldPoints = null;
      if (foundryPoly && foundryPoly.length >= 6) {
        worldPoints = [];
        for (let i = 0; i < foundryPoly.length; i += 2) {
          const wp = Coordinates.toWorld(foundryPoly[i], foundryPoly[i + 1]);
          worldPoints.push(wp.x, wp.y);
        }
      } else if (this.params.wallClipEnabled) {
        if (outdoor < 0.45) {
          // Indoor: no circle fallback — prevents wall bleed-through.
          continue;
        }
        // Outdoor: radial pool when wall clip fails (open yard / partial geometry).
      }

      const innerRadiusPx = Math.max(1, radiusPx * glow.innerScale);

      const lm = new LightMesh(centerWorld, radiusPx, c.color, {
        innerRadiusPx,
        worldPoints,
        falloffExponent: glow.falloffExponent,
        achromaticRgb: false,
        edgeSoftness: glow.edgeSoftness,
      });

      lm.setAchromaticRgb?.(false);
      lm.setEmissionGain?.(0);

      if (lm?.mesh) {
        lm.mesh.renderOrder = 90;
        this._glowGroup.add(lm.mesh);
      }

      const baseColor = new THREE.Color(c.color.r, c.color.g, c.color.b);

      this._glowBuckets.set(c.key, {
        lightMesh: lm,
        baseColor,
        intensity: c.intensity,
        phase: c.phase,
        outdoor: c.outdoor
      });
    }

    if (detached && lightScene && glowGroup) {
      try {
        lightScene.add(glowGroup);
      } catch (_) {
      }
    }
  }

  _updateGlowFlicker(timeInfo) {
    if (!this.params.glowEnabled) return;
    if (!this._glowBuckets.size) return;

    const THREE = window.THREE;
    if (!THREE) return;

    const t = timeInfo.elapsed;
    const dayNightMul = this._computeGlowDayNightIntensityMul();

    for (const entry of this._glowBuckets.values()) {
      const lm = entry?.lightMesh;
      const u = lm?.material?.uniforms;
      if (!u?.uColor?.value) continue;

      const phase = entry.phase || 0;
      const outdoor = entry.outdoor ?? 1.0;
      const glow = this._resolveGlowParams(null, outdoor);
      const strength = glow.flickerStrength;
      const speed = glow.flickerSpeed;
      const speedJ = glow.flickerSpeedJitter;
      const strengthJ = glow.flickerStrengthJitter;
      const clipScale = Math.max(0.1, Number(this.params.wallClipRadiusScale) || 1.0);
      const radiusPx = Math.max(32, glow.radiusPx * clipScale);
      const innerRadiusPx = Math.max(1, radiusPx * glow.innerScale);

      lm.setOuterRadiusPx?.(radiusPx);
      lm.setInnerRadiusPx?.(innerRadiusPx);
      lm.setFalloffExponent?.(glow.falloffExponent);
      lm.setEdgeSoftness?.(glow.edgeSoftness);

      // Stable per-bucket jitter so nearby candles can still share a glow bucket,
      // but buckets won't flicker in perfect sync.
      const r1 = Math.sin((phase + 0.17) * 1000.0) * 43758.5453;
      const r2 = Math.sin((phase + 0.61) * 1000.0) * 24631.1337;
      const rand01 = r1 - Math.floor(r1);
      const rand01b = r2 - Math.floor(r2);
      const speedVar = 1.0 + (rand01 * 2.0 - 1.0) * speedJ;
      const strengthVar = 1.0 + (rand01b * 2.0 - 1.0) * strengthJ;

      const baseAmp = (outdoor > 0.5) ? 0.55 : 0.35;
      const baseSpd = (outdoor > 0.5) ? 1.25 : 0.95;

      const spd = (speed > 0 ? (speed * baseSpd) : (baseSpd * 6.0)) * Math.max(0.05, speedVar);

      const n1 = Math.sin(t * spd + phase * 6.2831);
      const n2 = Math.sin(t * (spd * 1.73) + phase * 11.7);
      const n3 = Math.sin(t * (spd * 2.91) + phase * 23.1);

      // Stronger, more chaotic candle-light flicker. This only affects the glow.
      const chaos = (0.55 * n1 + 0.30 * n2 + 0.15 * n3);
      const flicker = Math.max(0.05, 1.0 + (baseAmp * strength * Math.max(0.05, strengthVar)) * chaos);

      const indoorMul = this._computeGlowIndoorNightBoost(outdoor);
      const outdoorMul = this._computeGlowOutdoorNightBoost(outdoor);
      const visualMul = Math.max(
        0.0,
        glow.intensity
          * Math.max(0.25, entry.intensity)
          * flicker
          * dayNightMul
          * indoorMul
          * outdoorMul
      );

      const glowColor = this._computeGlowColor(glow.warmth);
      // Hue only in uColor — intensity/flicker scales uEmissionGain (matches point-light buffer model).
      u.uColor.value.setRGB(glowColor.r, glowColor.g, glowColor.b);
      lm.setAchromaticRgb?.(false);

      const emissionGain = this._computeGlowEmissionGain(visualMul, glow.cancel);
      if (typeof lm.setEmissionGain === 'function') {
        lm.setEmissionGain(emissionGain);
      } else if (lm.material?.uniforms?.uEmissionGain) {
        lm.material.uniforms.uEmissionGain.value = emissionGain;
      }
    }
  }
}

export default CandleFlamesEffectV2;
