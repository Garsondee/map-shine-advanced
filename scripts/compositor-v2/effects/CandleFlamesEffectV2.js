import { createLogger } from '../../core/log.js';
import Coordinates from '../../utils/coordinates.js';
import { LightingDirector } from '../../core/LightingDirector.js';
import { computeTimeOfDayDarkness01 } from '../../core/foundry-time-phases.js';
import { weatherController } from '../../core/WeatherController.js';
import { resolveTwilightDarkness01 } from './ambient-compose-cpu.js';
import {
  buildCandleMinimapEntries,
  glowCentroidBounds,
  isFireBucketInView,
  resolveFireStreamingViewRect,
} from '../../streaming/fire-streaming-bridge.js';
import {
  getStreamingDetailTier,
  getStreamingEffectGateState,
  resolveFocalLodFromZoom,
} from '../../streaming/streaming-detail-api.js';
import {
  buildEffectSceneBoundsFromCanvas,
  sampleAuthoredOutdoorsAtWorld,
  syncSharedOutdoorsMaskForFloor,
} from './water-splash-behaviors.js';
import { getPerspectiveElevation } from '../../foundry/elevation-context.js';
import {
  hasV14NativeLevels,
  isWallOnV14Level,
  readWallHeightFlags,
} from '../../foundry/levels-scene-flags.js';
import { readWallSenseRestriction } from '../../foundry/wall-document-api.js';
import { resolveClusteringElevation } from '../../scene/map-point-wall-clustering.js';
import {
  buildMapPointGroupSpawnPool,
  inferMapPointGroupEmissionShape,
} from '../../scene/map-point-emission-sampling.js';
import {
  MAP_POINT_RENDER_LAYER_ABOVE,
  MAP_POINT_RENDER_LAYER_BELOW,
} from '../../scene/map-points-manager.js';
import {
  effectAboveOverheadOrder,
  effectUnderOverheadOrder,
} from '../LayerOrderPolicy.js';
import { VisionPolygonComputer } from '../../vision/VisionPolygonComputer.js';
import { LightMesh } from '../../scene/LightMesh.js';

const log = createLogger('CandleFlamesEffectV2');

// Flame sprites use per-band renderOrder (below vs above overhead); see _applyFlameMeshRenderOrders.
const CANDLE_FLAME_BELOW_INTRA = 60;
const CANDLE_FLAME_ABOVE_INTRA = 60;

/** Max candle clusters activated per frame when view streaming is on. */
const CANDLE_STREAM_CREATE_BUDGET = 4;
/** Focal LOD before candle flames economize (tile streaming may already be coarse at LOD 2). */
const CANDLE_FLAME_COMPACT_FOCAL_LOD = 3;
/** Focal LOD for flicker-only flames and throttled glow updates. */
const CANDLE_FLAME_MINIMAL_FOCAL_LOD = 4;

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Explicit null/undefined means "resolve live"; never coerce null → 0 (full day). */
function resolveOptionalDarkness01(darkness, resolveLive) {
  if (darkness != null && Number.isFinite(Number(darkness))) {
    return clamp01(Number(darkness));
  }
  return clamp01(resolveLive());
}

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

/** Day/night gameplay-light pool params — live uniform sync keyed off master darkness. */
const GLOW_DAY_NIGHT_POOL_PARAMS = new Set([
  'glowDayIntensityScale',
  'glowNightIntensityScale',
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
]);

/** @param {import('three').WebGLRenderer|null} renderer @param {import('three').Texture|null} texture */
function _isSamplingActiveRenderTarget(renderer, texture) {
  if (!renderer || !texture) return false;
  const active = renderer.getRenderTarget?.();
  return !!(active?.texture && active.texture === texture);
}

/** Glow colour endpoints for warmth slider (0 = neutral, 1 = deep candle / torch amber). */
const GLOW_COLOR_COOL = { r: 1.0, g: 1.0, b: 1.0 };
const GLOW_COLOR_WARM = { r: 1.0, g: 0.58, b: 0.12 };

/**
 * Candle pools: remap authored Hot Core Scale so the bright region reads as most of the flame,
 * not a pinprick inside a saturated orange disc (legacy low slider values were too small).
 * @param {number} raw 0.05..1 from Tweakpane
 * @returns {number} effective inner/outer radius ratio for LightMesh
 */
function remapCandleGlowInnerScale(raw) {
  const s = Math.max(0.05, Math.min(1, Number(raw) || 0.2));
  const t = Math.pow((s - 0.05) / 0.95, 0.55);
  return 0.52 + t * 0.36;
}

/** Softer halo falloff — lower exponent widens the gentle rim instead of a dense orange blob. */
function remapCandleGlowFalloffExponent(raw) {
  const e = Math.max(0.5, Number(raw) || 1.25);
  return Math.max(0.45, e * 0.78);
}

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
      candleViewStreaming: true,

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
      glowInnerRadiusScale: 0.55,
      glowFalloffExponent: 0.95,
      glowEdgeSoftness: 0.92,
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
      glowNightInnerRadiusScale: 0.48,
      glowNightFalloffExponent: 1.15,
      glowNightEdgeSoftness: 0.72,
      glowNightFlickerStrength: 0,
      glowNightFlickerSpeed: 6.3,
      glowNightFlickerStrengthJitter: 0.78,
      glowNightFlickerSpeedJitter: 0.68,
      wallClipEnabled: true,

      glowShapeMotionEnabled: true,
      glowShapeMaster: 0.32,
      glowShapeSpeed: 0.85,
      glowShapeLinkFlameMotion: true,
      glowShapeChaos: 0.25,
      glowShapeCenterShift: 0.38,
      glowShapeCenterVertical: 0.55,
      glowShapeOvalStretch: 0.28,
      glowShapeOvalRotate: 0.22,
      glowShapeReachPulse: 0.24,
      glowShapeCorePulse: 0.28,
      glowShapeBrightnessLink: 0.3,
      glowShapeIndoorScale: 0.85,
      glowShapeOutdoorScale: 1.0,

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
    this._groupBelow = null;
    this._groupAbove = null;
    this._flameMeshBelow = null;
    this._flameMeshAbove = null;
    this._flameMaterial = null;
    this._flameGeometryBelow = null;
    this._flameGeometryAbove = null;

    this._dummy = null;

    this._phaseArrayBelow = null;
    this._phaseArrayAbove = null;
    this._outdoorArrayBelow = null;
    this._outdoorArrayAbove = null;
    this._intensityArrayBelow = null;
    this._intensityArrayAbove = null;
    this._colorArrayBelow = null;
    this._colorArrayAbove = null;

    this._visionComputer = new VisionPolygonComputer();

    this._glowGroup = null;
    this._glowBuckets = new Map();
    this._clusters = [];
    /** @type {Array<object>} Full cluster registry (view streaming). */
    this._clusterRegistry = [];
    /** @type {Set<string>} Active in-view cluster keys. */
    this._activeClusterKeys = new Set();
    /** @type {import('../../streaming/streaming-detail-api.js').StreamingDetailTier} */
    this._lastDetailTier = 'full';
    this._glowFlickerSkipCounter = 0;

    this._tempColor = null;

    this._hookIds = [];
    this._needsGlowRebuild = false;
    this._lastGlowRebuildAt = -Infinity;
    this._outdoorsGlowRebuildPending = false;
    this._lastOutdoorsGlowRebuildAt = -Infinity;

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
            'candleViewStreaming',
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
          name: 'glow-shape',
          label: 'Glow — Light Shape',
          type: 'folder',
          expanded: true,
          parameters: [
            'glowShapeMotionEnabled',
            'glowShapeMaster',
            'glowShapeSpeed',
            'glowShapeLinkFlameMotion',
            'glowShapeChaos',
            'glowShapeCenterShift',
            'glowShapeCenterVertical',
            'glowShapeOvalStretch',
            'glowShapeOvalRotate',
            'glowShapeReachPulse',
            'glowShapeCorePulse',
            'glowShapeBrightnessLink',
            'glowShapeIndoorScale',
            'glowShapeOutdoorScale',
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
        glowShapeMotionEnabled: {
          type: 'boolean',
          default: true,
          label: 'Shape Motion',
          tooltip: 'Organic pool deformation: center wander, oval stretch, and size pulse synced to flame motion.',
        },
        glowShapeMaster: {
          type: 'slider', min: 0, max: 1.5, step: 0.01, default: 0.32, label: 'Master Scale',
          tooltip: 'Overall strength of all light-shape motion. Lower = calmer, more stable pools.',
        },
        glowShapeSpeed: {
          type: 'slider', min: 0.05, max: 2.5, step: 0.05, default: 0.85, label: 'Motion Speed',
          tooltip: 'How fast the pool shape oscillates. Does not affect glow brightness flicker.',
        },
        glowShapeLinkFlameMotion: {
          type: 'boolean',
          default: true,
          label: 'Follow Flame Motion',
          tooltip: 'When on, shape motion uses Flames folder wobble/sway/draft/wind. When off, uses Chaos only.',
        },
        glowShapeChaos: {
          type: 'slider', min: 0, max: 1.0, step: 0.01, default: 0.25, label: 'Standalone Chaos',
          tooltip: 'Agitation when Follow Flame Motion is off, or extra noise mixed in when on.',
        },
        glowShapeCenterShift: {
          type: 'slider', min: 0, max: 1.0, step: 0.01, default: 0.38, label: 'Center Wander',
          tooltip: 'How far the bright core drifts horizontally from the candle anchor.',
        },
        glowShapeCenterVertical: {
          type: 'slider', min: 0, max: 1.0, step: 0.01, default: 0.55, label: 'Vertical Wander',
          tooltip: 'Vertical component of center drift (0 = mostly horizontal lean).',
        },
        glowShapeOvalStretch: {
          type: 'slider', min: 0, max: 1.0, step: 0.01, default: 0.28, label: 'Oval Stretch',
          tooltip: 'How much the pool breathes between wide and tall ellipses.',
        },
        glowShapeOvalRotate: {
          type: 'slider', min: 0, max: 1.0, step: 0.01, default: 0.22, label: 'Oval Rotation',
          tooltip: 'How much the ellipse orientation spins with draft or wind.',
        },
        glowShapeReachPulse: {
          type: 'slider', min: 0, max: 1.0, step: 0.01, default: 0.24, label: 'Pool Size Pulse',
          tooltip: 'Outer pool radius breathe — expands and contracts with flicker.',
        },
        glowShapeCorePulse: {
          type: 'slider', min: 0, max: 1.0, step: 0.01, default: 0.28, label: 'Hot Core Pulse',
          tooltip: 'Bright-core fraction pulse — mimics flame brightening without moving the rim.',
        },
        glowShapeBrightnessLink: {
          type: 'slider', min: 0, max: 1.0, step: 0.01, default: 0.3, label: 'Brightness Link',
          tooltip: 'How much flame flicker modulates glow intensity (separate from shape motion).',
        },
        glowShapeIndoorScale: {
          type: 'slider', min: 0, max: 1.5, step: 0.01, default: 0.85, label: 'Indoor Scale',
          tooltip: 'Extra multiplier on shape motion for indoor (roof) pools.',
        },
        glowShapeOutdoorScale: {
          type: 'slider', min: 0, max: 1.5, step: 0.01, default: 1.0, label: 'Outdoor Scale',
          tooltip: 'Extra multiplier on shape motion for outdoor pools.',
        },
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
          type: 'slider', min: 0.05, max: 1.0, step: 0.01, default: 0.48, label: 'Hot Core Scale',
          tooltip: 'Bright pool fraction at full night. Values are remapped so the hot core reads as most of the flame, not a pinprick in an orange disc.',
        },
        glowNightFalloffExponent: {
          type: 'slider', min: 0.5, max: 5.0, step: 0.05, default: 1.15, label: 'Falloff Exponent',
          tooltip: 'Night halo softness. Lower = wider gentle rim; higher = tighter core (remapped for candle pools).',
        },
        glowNightEdgeSoftness: {
          type: 'slider', min: 0, max: 1.0, step: 0.01, default: 0.72, label: 'Pool Edge Softness',
          tooltip: 'Night rim feather in the HDR light buffer.',
        },
        glowFlickerStrength: { type: 'slider', min: 0, max: 10.0, step: 0.05, default: 0.05, label: 'Flicker Strength' },
        glowFlickerSpeed: { type: 'slider', min: 0, max: 25.0, step: 0.1, default: 5.3, label: 'Flicker Speed' },
        glowFlickerStrengthJitter: { type: 'slider', min: 0, max: 1.0, step: 0.01, default: 0.24, label: 'Flicker Strength Jitter' },
        glowFlickerSpeedJitter: { type: 'slider', min: 0, max: 1.0, step: 0.01, default: 1.0, label: 'Flicker Speed Jitter' },
        glowRadiusPx: { type: 'slider', min: 8, max: 1200, step: 2, default: 514.0, label: 'Pool Radius (px)' },
        glowInnerRadiusScale: {
          type: 'slider', min: 0.05, max: 1.0, step: 0.01, default: 0.55, label: 'Hot Core Scale',
          tooltip: 'Bright pool fraction at full day. Remapped so the HDR core occupies most of the pool.',
        },
        glowFalloffExponent: {
          type: 'slider', min: 0.5, max: 5.0, step: 0.05, default: 0.95, label: 'Falloff Exponent',
          tooltip: 'Day halo softness. Lower = wider gentle rim (remapped for candle pools).',
        },
        glowEdgeSoftness: {
          type: 'slider', min: 0, max: 1.0, step: 0.01, default: 0.92, label: 'Pool Edge Softness',
          tooltip: 'Feathers the glow rim in the HDR light buffer. Drives shader attenuation + rim geometry (higher = wider, softer pool).',
        },
        glowBucketSizePx: {
          type: 'slider', min: 64, max: 2048, step: 16, default: 384.0, label: 'Bucket Size (px)',
          tooltip: 'Spatial cluster size for glow pools. Lower values improve wall clipping; large buckets merge distant candles and can bleed through walls.',
        },
        glowMaxBuckets: { type: 'slider', min: 1, max: 512, step: 1, default: 256, label: 'Max Buckets' },
        candleViewStreaming: {
          type: 'checkbox',
          label: 'View Streaming (Cull Off-Screen)',
          default: true,
          tooltip: 'Only simulate and render candle clusters inside the camera view. Off-screen clusters are torn down to save CPU.',
        },
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
      this._syncFlameShaderUniforms();
    }

    if (paramId === 'flameFlickerSpeed' && this._flameMaterial?.uniforms?.uFlickerSpeed) {
      this._syncFlameShaderUniforms();
    }

    if (paramId === 'flameFlickerStrength' && this._flameMaterial?.uniforms?.uFlickerStrength) {
      this._syncFlameShaderUniforms();
    }

    if (paramId === 'flameFlickerSpeedJitter' && this._flameMaterial?.uniforms?.uFlickerSpeedJitter) {
      this._syncFlameShaderUniforms();
    }

    if (paramId === 'flameFlickerStrengthJitter' && this._flameMaterial?.uniforms?.uFlickerStrengthJitter) {
      this._syncFlameShaderUniforms();
    }

    if (paramId === 'flameSizeJitter') {
      this._rebuildFromMapPoints();
      return;
    }

    if (paramId === 'flameOvality' && this._flameMaterial?.uniforms?.uOvality) {
      this._syncFlameShaderUniforms();
    }

    if (paramId === 'flameWobble' && this._flameMaterial?.uniforms?.uWobble) {
      this._syncFlameShaderUniforms();
    }

    if (paramId === 'flameWobbleSpeed' && this._flameMaterial?.uniforms?.uWobbleSpeed) {
      this._syncFlameShaderUniforms();
    }

    if (paramId === 'flameWobbleNoise' && this._flameMaterial?.uniforms?.uWobbleNoise) {
      this._syncFlameShaderUniforms();
    }

    if (paramId === 'flameShapeDistort' && this._flameMaterial?.uniforms?.uShapeDistort) {
      this._syncFlameShaderUniforms();
    }

    if (paramId === 'flameIndoorSway' && this._flameMaterial?.uniforms?.uIndoorSway) {
      this._syncFlameShaderUniforms();
    }

    if (paramId === 'draftiness' && this._flameMaterial?.uniforms?.uDraftiness) {
      this._syncFlameShaderUniforms();
    }

    if (paramId === 'outdoorWindInfluence' && this._flameMaterial?.uniforms?.uOutdoorWindInfluence) {
      this._syncFlameShaderUniforms();
    }

    if (paramId === 'outdoorSway' && this._flameMaterial?.uniforms?.uOutdoorSway) {
      this._syncFlameShaderUniforms();
    }

    if (paramId === 'flamesEnabled') {
      this._setFlameCount(this.params.flamesEnabled ? this._sourceFlameCount : 0);
      return;
    }

    if (paramId === 'maxFlames') {
      this._createFlameMesh();
      if (this._group && this._flameMeshBelow && !this._flameMeshBelow.parent) {
        this._groupBelow?.add(this._flameMeshBelow);
      }
      if (this._group && this._flameMeshAbove && !this._flameMeshAbove.parent) {
        this._groupAbove?.add(this._flameMeshAbove);
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

    if (GLOW_DAY_NIGHT_POOL_PARAMS.has(paramId)) {
      this._applyLiveGlowBalance();
      if (GLOW_REBUILD_PARAMS.has(paramId)) {
        this._refreshGlowClusterRadii();
        this._scheduleGlowRebuild();
      }
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
    const darkness = this._resolveMasterDarkness();
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

    const showFlames = show && !!this.params.flamesEnabled && this._effectiveShowFlames();
    if (this._flameMeshBelow) {
      this._flameMeshBelow.visible = showFlames && (this._flameMeshBelow.count > 0);
    }
    if (this._flameMeshAbove) {
      this._flameMeshAbove.visible = showFlames && (this._flameMeshAbove.count > 0);
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
    this._groupBelow = new THREE.Group();
    this._groupBelow.name = 'CandleFlamesBelow';
    this._groupAbove = new THREE.Group();
    this._groupAbove.name = 'CandleFlamesAbove';
    this._group.add(this._groupBelow);
    this._group.add(this._groupAbove);

    this._createFlameMesh();

    if (this._flameMeshBelow) {
      this._groupBelow.add(this._flameMeshBelow);
    }
    if (this._flameMeshAbove) {
      this._groupAbove.add(this._flameMeshAbove);
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

    if (this._flameMeshBelow && this._flameMeshBelow.parent !== this._groupBelow) {
      try { this._groupBelow.add(this._flameMeshBelow); } catch (_) {}
    }
    if (this._flameMeshAbove && this._flameMeshAbove.parent !== this._groupAbove) {
      try { this._groupAbove.add(this._flameMeshAbove); } catch (_) {}
    }
  }

  update(timeInfo) {
    if (!this.params.enabled) {
      this._applyVisibility();
      return;
    }

    const streamGate = getStreamingEffectGateState();
    this._lastDetailTier = streamGate.tier;

    const THREE = window.THREE;
    if (!THREE) return;

    this._sceneBounds = buildEffectSceneBoundsFromCanvas();

    this._tryAttachGlowGroup();

    if (this._isCandleViewStreamingEnabled()) {
      this._syncCandleClusterView();
    }

    if (this._flameMaterial?.uniforms?.uTime) {
      this._flameMaterial.uniforms.uTime.value = timeInfo.elapsed;
    }

    this._syncFlameShaderUniforms();

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

    if (this._outdoorsGlowRebuildPending
      && (timeInfo.elapsed - this._lastOutdoorsGlowRebuildAt) > 0.4) {
      this._rebuildGlowMeshes();
      this._outdoorsGlowRebuildPending = false;
      this._lastOutdoorsGlowRebuildAt = timeInfo.elapsed;
    }

    this._updateGlowFlicker(timeInfo);
  }

  /** @private */
  _isCandleViewStreamingEnabled() {
    return this.params.candleViewStreaming !== false;
  }

  /** @private */
  _effectiveShowFlames() {
    return !!this.params.flamesEnabled;
  }

  /**
   * Zoom LOD profile for instanced candle flame sprites.
   * Lags behind tile streaming detail — full flames until overview focal LOD.
   *
   * @returns {{ motionMul: number, detailMul: number, compact: boolean, throttleGlow: boolean, lodKey: 'full'|'compact'|'minimal' }}
   * @private
   */
  _resolveCandleFlameLodProfile() {
    const focalLod = resolveFocalLodFromZoom();
    if (focalLod >= CANDLE_FLAME_MINIMAL_FOCAL_LOD) {
      return { motionMul: 0.0, detailMul: 0.0, compact: true, throttleGlow: true, lodKey: 'minimal' };
    }
    if (focalLod >= CANDLE_FLAME_COMPACT_FOCAL_LOD) {
      return { motionMul: 0.35, detailMul: 0.15, compact: true, throttleGlow: false, lodKey: 'compact' };
    }
    return { motionMul: 1.0, detailMul: 1.0, compact: false, throttleGlow: false, lodKey: 'full' };
  }

  /** @private */
  _syncFlameShaderUniforms() {
    const m = this._flameMaterial;
    if (!m?.uniforms) return;

    const profile = this._resolveCandleFlameLodProfile();
    const p = this.params;
    const u = m.uniforms;

    if (u.uOpacity) {
      u.uOpacity.value = p.flameOpacity * this._computeDayNightIntensityMul();
    }
    if (u.uFlickerSpeed) u.uFlickerSpeed.value = p.flameFlickerSpeed;
    if (u.uFlickerStrength) u.uFlickerStrength.value = p.flameFlickerStrength;
    if (u.uFlickerSpeedJitter) u.uFlickerSpeedJitter.value = p.flameFlickerSpeedJitter;
    if (u.uFlickerStrengthJitter) u.uFlickerStrengthJitter.value = p.flameFlickerStrengthJitter;
    if (u.uOvality) u.uOvality.value = p.flameOvality;
    if (u.uWobble) u.uWobble.value = p.flameWobble * profile.detailMul;
    if (u.uWobbleSpeed) u.uWobbleSpeed.value = p.flameWobbleSpeed;
    if (u.uWobbleNoise) u.uWobbleNoise.value = p.flameWobbleNoise * profile.detailMul;
    if (u.uShapeDistort) u.uShapeDistort.value = p.flameShapeDistort * profile.detailMul;
    if (u.uIndoorSway) u.uIndoorSway.value = p.flameIndoorSway * profile.motionMul;
    if (u.uDraftiness) u.uDraftiness.value = p.draftiness * profile.motionMul;
    if (u.uOutdoorWindInfluence) u.uOutdoorWindInfluence.value = p.outdoorWindInfluence * profile.motionMul;
    if (u.uOutdoorSway) u.uOutdoorSway.value = p.outdoorSway * profile.motionMul;

    if (u.uWindSpeed) {
      let ws = 0.0;
      try {
        ws = Number(weatherController?.getCurrentState?.()?.windSpeed ?? weatherController?.currentState?.windSpeed ?? 0.0) || 0.0;
      } catch (_) {
        ws = 0.0;
      }
      u.uWindSpeed.value = Math.max(0.0, Math.min(1.0, ws * profile.motionMul));
    }

    if (u.uWindDir) {
      try {
        const state = weatherController?.getCurrentState?.() ?? weatherController?.currentState;
        const dir = state?.windDirection;
        if (dir && Number.isFinite(dir.x) && Number.isFinite(dir.y)) {
          u.uWindDir.value.set(dir.x, -dir.y);
        }
      } catch (_) {
      }
    }
  }

  /**
   * Minimap snapshot of candle cluster view-streaming state.
   * @returns {{ clusters: Array<{ clusterKey: string, bounds: object, state: string }>, activeCount: number, totalCount: number }}
   */
  getCandleStreamingMinimapSnapshot() {
    const profile = this._resolveCandleFlameLodProfile();
    const view = resolveFireStreamingViewRect();
    /** @type {Array<{ clusterKey: string, bounds: object, active: boolean, compact?: boolean }>} */
    const rows = [];
    for (const entry of this._clusterRegistry) {
      if (!entry?.bounds) continue;
      const inView = !this._isCandleViewStreamingEnabled() || isFireBucketInView(entry.bounds, view);
      const active = this._activeClusterKeys.has(entry.key);
      const compact = profile.compact && inView && active && this._effectiveShowFlames();
      rows.push({
        clusterKey: entry.key,
        bounds: entry.bounds,
        active: inView && active,
        compact,
      });
    }
    const clusters = buildCandleMinimapEntries(rows);
    const activeCount = clusters.filter((c) => c.state === 'candle-active' || c.state === 'candle-compact').length;
    return { clusters, activeCount, totalCount: clusters.length };
  }

  /**
   * @returns {{ viewStreaming: boolean, detailTier: string, totalClusters: number, activeClusters: number, culledClusters: number }}
   */
  getCandleStreamingReportSummary() {
    const snap = this.getCandleStreamingMinimapSnapshot();
    const profile = this._resolveCandleFlameLodProfile();
    return {
      viewStreaming: this._isCandleViewStreamingEnabled(),
      detailTier: this._lastDetailTier ?? getStreamingDetailTier(),
      candleFlameLod: profile.lodKey,
      focalLod: resolveFocalLodFromZoom(),
      totalClusters: snap.totalCount,
      activeClusters: snap.activeCount,
      culledClusters: Math.max(0, snap.totalCount - snap.activeCount),
    };
  }

  /**
   * @param {Set<string>} activeKeys
   * @param {import('../../streaming/streaming-detail-api.js').StreamingDetailTier} [tier]
   * @private
   */
  _applyActiveClusters(activeKeys, tier = this._lastDetailTier) {
    this._activeClusterKeys = new Set(activeKeys ?? []);
    const showFlames = this._effectiveShowFlames();

    this._clusters.length = 0;
    for (const entry of this._clusterRegistry) {
      if (!this._activeClusterKeys.has(entry.key)) continue;
      if (entry.cluster) this._clusters.push(entry.cluster);
    }

    const maxFlames = Math.max(0, this.params.maxFlames | 0);
    const flameSize = Math.max(1, this.params.flameSizePx);
    const sizeJitter = Math.max(0.0, Math.min(1.0, Number(this.params.flameSizeJitter) || 0.0));
    const groundZ = this._getGroundZ();
    const baseR = 1.0;
    const baseG = 1.0;
    const baseB = 1.0;

    let writtenBelow = 0;
    let writtenAbove = 0;

    if (showFlames) {
      for (const entry of this._clusterRegistry) {
        if (!this._activeClusterKeys.has(entry.key)) continue;
        for (const pt of entry.points ?? []) {
          const wx = pt.x;
          const wy = pt.y;
          const renderLayer = pt.renderLayer ?? MAP_POINT_RENDER_LAYER_BELOW;
          const outdoor = Number.isFinite(Number(pt.outdoor))
            ? Number(pt.outdoor)
            : this._sampleGlowOutdoorAtWorld(wx, wy, {
              floorIndex: pt.floorCtx?.floorIndex,
              renderLayer,
            });
          const aboveOverhead = renderLayer === MAP_POINT_RENDER_LAYER_ABOVE;
          const flameMesh = aboveOverhead ? this._flameMeshAbove : this._flameMeshBelow;
          const writeIdx = aboveOverhead ? writtenAbove : writtenBelow;
          if (!flameMesh || writeIdx >= maxFlames) continue;

          const phase = this._hash2(wx, wy);
          const sizeRand = Math.sin((phase + 0.13) * 1000.0) * 43758.5453;
          const size01 = sizeRand - Math.floor(sizeRand);
          const sizeVar = 1.0 + (size01 * 2.0 - 1.0) * sizeJitter;
          const s = Math.max(1.0, flameSize * Math.max(0.2, sizeVar));

          this._dummy.position.set(wx, wy, groundZ + 3.5);
          this._dummy.rotation.set(0, 0, phase * Math.PI * 2);
          this._dummy.scale.set(s, s, 1);
          this._dummy.updateMatrix();
          flameMesh.setMatrixAt(writeIdx, this._dummy.matrix);

          const phaseArray = aboveOverhead ? this._phaseArrayAbove : this._phaseArrayBelow;
          const outdoorArray = aboveOverhead ? this._outdoorArrayAbove : this._outdoorArrayBelow;
          const intensityArray = aboveOverhead ? this._intensityArrayAbove : this._intensityArrayBelow;
          const colorArray = aboveOverhead ? this._colorArrayAbove : this._colorArrayBelow;

          phaseArray[writeIdx] = phase;
          outdoorArray[writeIdx] = outdoor;
          intensityArray[writeIdx] = Math.max(0.25, Number(pt.intensity) || 0);
          const cIdx = writeIdx * 3;
          colorArray[cIdx] = baseR;
          colorArray[cIdx + 1] = baseG;
          colorArray[cIdx + 2] = baseB;

          if (aboveOverhead) writtenAbove += 1;
          else writtenBelow += 1;
        }
      }
    }

    this._sourceFlameCount = writtenBelow + writtenAbove;
    this._setFlameCounts(
      showFlames && this.params.flamesEnabled ? writtenBelow : 0,
      showFlames && this.params.flamesEnabled ? writtenAbove : 0,
    );
    this._applyFlameMeshRenderOrders();
    this._applyVisibility();

    if (this._clusters.length) {
      this._rebuildGlowMeshes();
    } else {
      this._clearGlowBuckets();
    }
  }

  /**
   * @param {{ createBudget?: number }} [options]
   * @returns {boolean}
   * @private
   */
  _syncCandleClusterView(options = {}) {
    if (!this._clusterRegistry.length) return false;

    const createBudget = Number.isFinite(Number(options.createBudget))
      ? Math.max(0, Math.floor(Number(options.createBudget)))
      : CANDLE_STREAM_CREATE_BUDGET;
    const view = this._isCandleViewStreamingEnabled() ? resolveFireStreamingViewRect() : null;

    /** @type {Set<string>} */
    const nextActive = new Set();
    let created = 0;

    if (!this._isCandleViewStreamingEnabled()) {
      for (const entry of this._clusterRegistry) nextActive.add(entry.key);
    } else {
      for (const entry of this._clusterRegistry) {
        const inView = isFireBucketInView(entry.bounds, view);
        if (inView) {
          if (!this._activeClusterKeys.has(entry.key)) {
            if (created >= createBudget) continue;
            created += 1;
          }
          nextActive.add(entry.key);
        }
      }
    }

    const sig = [...nextActive].sort().join(',');
    const prevSig = [...this._activeClusterKeys].sort().join(',');
    if (sig === prevSig) return false;

    this._applyActiveClusters(nextActive);
    return true;
  }

  render() {
  }

  onFloorChange(_maxFloorIndex) {
    this.setActiveLevelContext(window.MapShine?.activeLevelContext ?? null);
    this._sceneBounds = buildEffectSceneBoundsFromCanvas();
    this._applyFlameMeshRenderOrders();
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
   * Default outdoors strength when the _Outdoors CPU snapshot is unavailable.
   * Chandeliers (above-overhead) assume indoor; ground candles assume outdoor.
   * @private
   * @param {'below-overhead'|'above-overhead'} [renderLayer]
   * @returns {number}
   */
  _resolveCandleOutdoorFallback(renderLayer = MAP_POINT_RENDER_LAYER_BELOW) {
    return renderLayer === MAP_POINT_RENDER_LAYER_ABOVE ? 0.0 : 1.0;
  }

  /**
   * Authored _Outdoors at Three world XY (per-floor compositor mask, not WeatherController roof cache).
   * @private
   * @param {number} worldX
   * @param {number} worldY
   * @param {{ floorIndex?: number, renderLayer?: 'below-overhead'|'above-overhead' }} [opts]
   * @returns {number} 0..1 outdoors strength
   */
  _sampleGlowOutdoorAtWorld(worldX, worldY, opts = {}) {
    const renderLayer = opts.renderLayer === MAP_POINT_RENDER_LAYER_ABOVE
      ? MAP_POINT_RENDER_LAYER_ABOVE
      : MAP_POINT_RENDER_LAYER_BELOW;
    const floorIndex = Number.isFinite(Number(opts.floorIndex))
      ? Math.max(0, Math.floor(Number(opts.floorIndex)))
      : this._resolveGlowFloorIndex();
    const levelContext = this._activeLevelContext ?? window.MapShine?.activeLevelContext ?? null;
    const bounds = this._sceneBounds ?? buildEffectSceneBoundsFromCanvas();
    const fallback = this._resolveCandleOutdoorFallback(renderLayer);

    try {
      syncSharedOutdoorsMaskForFloor(floorIndex, this._outdoorsMaskFrameToken, levelContext);
    } catch (_) {}

    const raw = sampleAuthoredOutdoorsAtWorld(
      floorIndex,
      worldX,
      worldY,
      bounds,
      this._outdoorsMaskFrameToken,
      levelContext,
    );
    if (raw == null || !Number.isFinite(raw)) return fallback;
    return clamp01(raw);
  }

  /**
   * Re-sample indoor/outdoor for every registry point + cluster after _Outdoors decode.
   * @private
   */
  _refreshCandleOutdoorsClassification() {
    if (!this._clusterRegistry?.length) return;

    this._syncSceneBounds();

    for (const entry of this._clusterRegistry) {
      if (!entry) continue;
      const cluster = entry.cluster;
      const renderLayer = cluster?.renderLayer
        ?? entry.points?.[0]?.renderLayer
        ?? MAP_POINT_RENDER_LAYER_BELOW;
      const floorIndex = cluster?.floorCtx?.floorIndex
        ?? entry.points?.[0]?.floorCtx?.floorIndex;

      let minOutdoor = 1.0;
      let count = 0;

      for (const pt of entry.points ?? []) {
        if (!pt) continue;
        const outdoor = this._sampleGlowOutdoorAtWorld(pt.x, pt.y, {
          floorIndex: pt.floorCtx?.floorIndex ?? floorIndex,
          renderLayer: pt.renderLayer ?? renderLayer,
        });
        pt.outdoor = outdoor;
        minOutdoor = Math.min(minOutdoor, outdoor);
        count += 1;
      }

      if (!cluster || count <= 0) continue;

      const outdoorAtCenter = this._sampleGlowOutdoorAtWorld(cluster.cxWorld, cluster.cyWorld, {
        floorIndex,
        renderLayer,
      });
      cluster.outdoor = Math.min(
        Number.isFinite(minOutdoor) ? minOutdoor : outdoorAtCenter,
        outdoorAtCenter,
      );
    }

    this._applyActiveClusters(this._activeClusterKeys);
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
      if (this._flameMeshBelow) this._flameMeshBelow.removeFromParent();
      if (this._flameMeshAbove) this._flameMeshAbove.removeFromParent();
      if (this._flameGeometryBelow) this._flameGeometryBelow.dispose();
      if (this._flameGeometryAbove) this._flameGeometryAbove.dispose();
      if (this._flameMaterial) this._flameMaterial.dispose();
    } catch (_) {
    }

    try {
      this._group?.removeFromParent?.();
    } catch (_) {
    }

    this._flameMeshBelow = null;
    this._flameMeshAbove = null;
    this._flameGeometryBelow = null;
    this._flameGeometryAbove = null;
    this._flameMaterial = null;
    this._group = null;
    this._groupBelow = null;
    this._groupAbove = null;
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
   * Fresh canonical scene darkness for day/night pool blending.
   * Particle ticks can run before FloorCompositor.render(); update here so glow
   * pools never stick on the neutral pre-render default (0 = full day).
   *
   * Interior scenes often keep Foundry's darkness slider near 0 while the clock
   * is at night — candle pools must follow calendar time (and every authoritative
   * hour source), not only the live Foundry mirror.
   * @private
   * @returns {number}
   */
  _resolveCandleSceneHourCandidates() {
    /** @type {number[]} */
    const out = [];
    const push = (raw) => {
      const h = Number(raw);
      if (!Number.isFinite(h)) return;
      out.push(((h % 24) + 24) % 24);
    };
    try { push(window.MapShine?.controlPanel?.controlState?.timeOfDay); } catch (_) {}
    try { push(window.MapShine?.remoteControlState?.timeOfDay); } catch (_) {}
    try { push(weatherController?.timeOfDay); } catch (_) {}
    try { push(LightingDirector.get()?.hour); } catch (_) {}
    return out;
  }

  /** @private @returns {number} */
  _resolveMasterDarkness() {
    try { LightingDirector.update(); } catch (_) {}
    const state = LightingDirector.get();
    let darkness = clamp01(state.masterDarkness);

    const twilight = resolveTwilightDarkness01(this._lightingEffect);
    const twilightOpts = Number.isFinite(twilight)
      ? { dawnDuskDarkness: clamp01(twilight) }
      : {};

    if (Number.isFinite(state.calendarDarkness)) {
      darkness = Math.max(darkness, clamp01(state.calendarDarkness));
    }

    for (const hour of this._resolveCandleSceneHourCandidates()) {
      const cal = computeTimeOfDayDarkness01(hour, twilightOpts);
      if (Number.isFinite(cal)) darkness = Math.max(darkness, clamp01(cal));
    }

    return darkness;
  }

  /**
   * Darkness-driven scale for flame sprites only.
   * @returns {number}
   */
  _computeDayNightIntensityMul() {
    if (!this.params.autoDayNightBalance) return 1.0;

    const darkness = this._resolveMasterDarkness();
    const dayFloor = 0.55;
    const day = Math.max(dayFloor, Math.max(0, Number(this.params.dayIntensityScale) || 0));
    const night = Math.max(day, Math.max(0, Number(this.params.nightIntensityScale) || 0));
    const curve = Math.max(0.05, Number(this.params.dayNightCurve) || 1);
    const t = Math.pow(darkness, curve);
    return day + (night - day) * t;
  }

  /** @private @param {number} [darkness] */
  _blendGlowDayNightParam(dayKey, nightKey, fallback = 0, darkness = null) {
    const t = resolveOptionalDarkness01(darkness, () => this._resolveMasterDarkness());
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
  _resolveGlowBalanceOutdoorThreshold() {
    const raw = Number(this.params.indoorThreshold);
    return Number.isFinite(raw) ? clamp01(raw) : GLOW_BALANCE_OUTDOOR_THRESHOLD;
  }

  /** @private @param {number} outdoor01 @returns {boolean} */
  _isCandleIndoorOutdoorSample(outdoor01) {
    return clamp01(Number(outdoor01) || 0) <= this._resolveGlowBalanceOutdoorThreshold();
  }

  _snapGlowBalanceOutdoor(outdoor01) {
    return this._isCandleIndoorOutdoorSample(outdoor01) ? 0.0 : 1.0;
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
    const t = resolveOptionalDarkness01(darkness, () => this._resolveMasterDarkness());
    const base = {
      t,
      warmth: clamp01(this._blendGlowDayNightParam('glowWarmth', 'glowNightWarmth', 1.0, t)),
      intensity: Math.max(0, this._blendGlowDayNightParam('glowIntensity', 'glowNightIntensity', 0.42, t)),
      cancel: Math.max(0, this._blendGlowDayNightParam('glowDarknessCancel', 'glowNightDarknessCancel', 3.0, t)),
      radiusPx: Math.max(32, this._blendGlowDayNightParam('glowRadiusPx', 'glowNightRadiusPx', 172.0, t)),
      innerScale: Math.min(0.92, remapCandleGlowInnerScale(this._blendGlowDayNightParam(
        'glowInnerRadiusScale',
        'glowNightInnerRadiusScale',
        0.2,
        t,
      ))),
      falloffExponent: Math.min(5.0, Math.max(0.45, remapCandleGlowFalloffExponent(this._blendGlowDayNightParam(
        'glowFalloffExponent',
        'glowNightFalloffExponent',
        2.0,
        t,
      )))),
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
      this._forEachGlowLightMesh(entry, (lm) => {
        const u = lm?.material?.uniforms;
        if (!u?.uColor?.value) return;

        const outdoor = entry.outdoor ?? 1.0;
        const glow = this._resolveGlowParams(null, outdoor);
        const radiusPx = Math.max(32, glow.radiusPx * clipScale);
        const innerRadiusPx = Math.max(1, radiusPx * glow.innerScale);

        lm.setOuterRadiusPx?.(radiusPx);
        lm.setInnerRadiusPx?.(innerRadiusPx);
        lm.setFalloffExponent?.(glow.falloffExponent);
        lm.setEdgeSoftness?.(glow.edgeSoftness);

        if (falloffEdgeOnly) return;

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
      });
    }
  }

  _computeGlowDayNightIntensityMul() {
    const darkness = this._resolveMasterDarkness();
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

    const darkness = this._resolveMasterDarkness();
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
    const darkness = this._resolveMasterDarkness();
    const indoor = 1.0 - this._snapGlowBalanceOutdoor(outdoor01);
    return 1.0 + boost * indoor * darkness;
  }

  /** Extra glow outdoors at night (uses per-bucket roof mask). */
  _computeGlowOutdoorNightBoost(outdoor01) {
    const boost = Math.max(0, Number(this.params.glowOutdoorNightBoost) || 0);
    if (boost <= 0) return 1.0;
    const darkness = this._resolveMasterDarkness();
    const outdoor = this._snapGlowBalanceOutdoor(outdoor01);
    return 1.0 + boost * outdoor * darkness;
  }

  /**
   * Half-open wall-height band for a floor index (matches levels-create-defaults seam rules).
   * @private
   * @param {number} floorIndex
   * @returns {{bottom:number, top:number, floorIndex:number, levelId:string|null}|null}
   */
  _resolveFloorWallHeightBand(floorIndex) {
    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    const fi = Math.max(0, Math.floor(Number(floorIndex) || 0));
    const floor = floors[fi];
    if (!floor) return null;

    let bottom = Number(floor.elevationMin);
    if (!Number.isFinite(bottom)) return null;

    let top = Number(floor.elevationMax);
    if (fi + 1 < floors.length) {
      const nextBottom = Number(floors[fi + 1]?.elevationMin);
      if (Number.isFinite(nextBottom)) top = nextBottom;
    } else if (Number.isFinite(top)) {
      top += 1;
    } else {
      top = Infinity;
    }

    const levelId = (typeof floor.levelId === 'string' && floor.levelId.length > 0)
      ? floor.levelId
      : null;

    return { bottom, top, floorIndex: fi, levelId };
  }

  /**
   * Pick a test elevation inside a half-open [bottom, top) wall band.
   * @private
   * @param {{bottom:number, top:number}|null} band
   * @returns {number}
   */
  _resolveClipElevationFromBand(band) {
    if (!band || !Number.isFinite(Number(band.bottom))) {
      return resolveClusteringElevation(this._resolveGlowFloorIndex());
    }

    const bottom = Number(band.bottom);
    if (!Number.isFinite(band.top) || band.top === Infinity) {
      return bottom + 1;
    }

    const top = Number(band.top);
    const span = top - bottom;
    if (!(span > 0)) return bottom + 0.5;
    return bottom + Math.min(Math.max(span * 0.5, 0.5), span - 0.01);
  }

  /**
   * Floor / level context for wall clipping from a map-point group's level binding.
   * Map points only store x/y — floor ownership lives on the group metadata.
   * @private
   * @param {import('../../scene/map-points-manager.js').MapPointGroup|null|undefined} group
   * @returns {{floorIndex:number, levelId:string|null, bandBottom:number, bandTop:number, clipElevation:number}}
   */
  _resolveGroupFloorContext(group) {
    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    let floorIndex = this._resolveGlowFloorIndex();
    let levelId = this._activeLevelContext?.levelId
      ?? window.MapShine?.activeLevelContext?.levelId
      ?? null;
    let bandBottom = NaN;
    let bandTop = NaN;

    const binding = group?.metadata?.levelBinding;
    if (binding?.mode === 'locked') {
      if (typeof binding.floorKey === 'string' && binding.floorKey.length > 0) {
        levelId = binding.floorKey;
        const idx = floors.findIndex((f) => f?.levelId === binding.floorKey);
        if (idx >= 0) floorIndex = idx;
      }

      const b = Number(binding.bottom);
      const tRaw = binding.top;
      const t = Number.isFinite(Number(tRaw)) ? Number(tRaw) : Number(binding.bottom);
      if (Number.isFinite(b) && Number.isFinite(t)) {
        bandBottom = Math.min(b, t);
        bandTop = Math.max(b, t);
        if (!(typeof binding.floorKey === 'string' && binding.floorKey.length > 0)) {
          for (let i = 0; i < floors.length; i++) {
            const f = floors[i];
            const min = Number(f?.elevationMin);
            const max = Number(f?.elevationMax);
            if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
            if (bandTop < min || bandBottom > max) continue;
            floorIndex = i;
            if (!levelId && typeof f?.levelId === 'string') levelId = f.levelId;
            break;
          }
        }
      }
    }

    const stackBand = this._resolveFloorWallHeightBand(floorIndex);
    if (stackBand) {
      if (!Number.isFinite(bandBottom)) bandBottom = stackBand.bottom;
      if (!Number.isFinite(bandTop)) bandTop = stackBand.top;
      if (!levelId) levelId = stackBand.levelId;
    }

    const clipElevation = this._resolveClipElevationFromBand(
      Number.isFinite(bandBottom) ? { bottom: bandBottom, top: bandTop } : null,
    );

    return {
      floorIndex,
      levelId,
      bandBottom,
      bandTop,
      clipElevation,
    };
  }

  /**
   * Resolve the V14 Level document id used for wall membership tests on a cluster.
   * @private
   * @param {{levelId?:string|null, floorIndex?:number}|null} floorCtx
   * @returns {string|null}
   */
  _resolveGlowClipLevelId(floorCtx) {
    const direct = (typeof floorCtx?.levelId === 'string' && floorCtx.levelId.length > 0)
      ? floorCtx.levelId
      : null;
    if (direct) return direct;

    const fi = Number(floorCtx?.floorIndex);
    if (Number.isFinite(fi)) {
      const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
      const levelId = floors[Math.max(0, Math.floor(fi))]?.levelId;
      if (typeof levelId === 'string' && levelId.length > 0) return levelId;
    }

    const ctxLevelId = this._activeLevelContext?.levelId
      ?? window.MapShine?.activeLevelContext?.levelId
      ?? null;
    return (typeof ctxLevelId === 'string' && ctxLevelId.length > 0) ? ctxLevelId : null;
  }

  /**
   * All scene wall documents for glow clipping. Prefer the embedded collection
   * (every level) over canvas placeables (often only the viewed level's layer).
   * @private
   * @returns {object[]}
   */
  _collectGlowClipWallSources() {
    const scene = canvas?.scene;
    const embedded = scene?.walls;
    if (embedded?.size > 0) {
      const out = [];
      for (const doc of embedded) {
        if (!doc) continue;
        const placeable = canvas?.walls?.get?.(doc.id) ?? null;
        out.push(placeable ?? doc);
      }
      if (out.length > 0) return out;
    }
    return canvas?.walls?.placeables ?? [];
  }

  /**
   * Walls that block glow for a candle cluster's floor.
   * V14-native: Foundry assigns walls to floors via document.levels (dropdown),
   * not per-wall elevation — match that membership first.
   * Legacy: fall back to wall-height / Levels elevation bands.
   * @private
   * @param {object[]} walls
   * @param {{levelId?:string|null, floorIndex?:number, clipElevation?:number}|null} floorCtx
   * @returns {object[]}
   */
  _filterWallsForClusterClip(walls, floorCtx) {
    const list = Array.isArray(walls) ? walls : [];
    if (!list.length || !floorCtx) return list;

    const scene = canvas?.scene;
    if (hasV14NativeLevels(scene)) {
      const levelId = this._resolveGlowClipLevelId(floorCtx);
      if (levelId) {
        return list.filter((wallLike) => {
          const doc = wallLike?.document ?? wallLike;
          return !!doc && isWallOnV14Level(doc, levelId);
        });
      }
    }

    const elevation = Number(floorCtx.clipElevation);
    if (!Number.isFinite(elevation)) return list;

    return list.filter((wallLike) => {
      const doc = wallLike?.document ?? wallLike;
      if (!doc) return false;

      const bounds = readWallHeightFlags(doc);
      let wallBottom = Number(bounds?.bottom);
      let wallTop = Number(bounds?.top);
      if (!Number.isFinite(wallBottom)) wallBottom = -Infinity;
      if (!Number.isFinite(wallTop)) wallTop = Infinity;
      if (wallTop < wallBottom) {
        const swap = wallBottom;
        wallBottom = wallTop;
        wallTop = swap;
      }

      return elevation >= wallBottom && (wallTop === Infinity || elevation < wallTop);
    });
  }

  /**
   * @private
   */
  _countPhysicalGlowWallSegments(centerFoundry, radiusPx, walls, elevation) {
    if (!centerFoundry || !(radiusPx > 0) || !walls?.length) return 0;
    if (!Number.isFinite(Number(elevation))) return 0;
    return this._countGlowWallSegments(centerFoundry, radiusPx, walls, {
      sense: 'light',
      blockGeometry: true,
      elevation: Number(elevation),
    });
  }

  /**
   * Count wall segments that would participate in a glow clip (excludes boundary circle).
   * @private
   */
  _countGlowWallSegments(centerFoundry, radiusPx, walls, wallClipOptions) {
    if (!centerFoundry || !(radiusPx > 0) || !walls?.length) return 0;
    try {
      const segments = [];
      this._visionComputer.wallsToSegments(
        walls,
        centerFoundry,
        radiusPx,
        wallClipOptions?.sense === 'light' ? 'light' : 'sight',
        segments,
        wallClipOptions?.elevation,
        null,
        null,
        !!wallClipOptions?.blockGeometry,
      );
      return segments.length;
    } catch (_) {
      return 0;
    }
  }

  /**
   * Walls that block sight but not light still block indoor candle glow.
   * @private
   */
  _collectIndoorSightOnlyAdditionalSegments(centerFoundry, radiusPx, walls, elevation) {
    if (!centerFoundry || !(radiusPx > 0) || !walls?.length) return [];
    if (!Number.isFinite(Number(elevation))) return [];

    const sightOnlyWalls = [];
    for (const wallLike of walls) {
      const doc = wallLike?.document ?? wallLike;
      if (!doc) continue;
      if (readWallSenseRestriction(doc, 'light') !== 0) continue;
      if (readWallSenseRestriction(doc, 'sight') === 0) continue;
      sightOnlyWalls.push(wallLike);
    }
    if (!sightOnlyWalls.length) return [];

    const segments = [];
    try {
      this._visionComputer.wallsToSegments(
        sightOnlyWalls,
        centerFoundry,
        radiusPx,
        'sight',
        segments,
        Number(elevation),
        null,
        null,
        false,
      );
    } catch (_) {
      return [];
    }

    const out = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (!seg?.a || !seg?.b) continue;
      out.push({ x0: seg.a.x, y0: seg.a.y, x1: seg.b.x, y1: seg.b.y });
    }
    return out;
  }

  /**
   * @private
   * @param {import('../../scene/map-points-manager.js').MapPointGroup|null|undefined} group
   * @returns {'below-overhead'|'above-overhead'}
   */
  _resolveGroupRenderLayer(group) {
    return group?.metadata?.renderLayer === MAP_POINT_RENDER_LAYER_ABOVE
      ? MAP_POINT_RENDER_LAYER_ABOVE
      : MAP_POINT_RENDER_LAYER_BELOW;
  }

  /** @private */
  _applyFlameMeshRenderOrders() {
    const floorIndex = this._resolveGlowFloorIndex();
    if (this._groupBelow) {
      this._groupBelow.renderOrder = effectUnderOverheadOrder(
        floorIndex,
        CANDLE_FLAME_BELOW_INTRA,
      );
    }
    if (this._groupAbove) {
      this._groupAbove.renderOrder = effectAboveOverheadOrder(
        floorIndex,
        CANDLE_FLAME_ABOVE_INTRA,
      );
    }
    if (this._flameMeshBelow) this._flameMeshBelow.renderOrder = 0;
    if (this._flameMeshAbove) this._flameMeshAbove.renderOrder = 0;
  }

  /**
   * @private
   * @param {import('../../scene/LightMesh.js').LightMesh|null|undefined} lm
   * @param {'below-overhead'|'above-overhead'} renderLayer
   */
  _tagGlowMeshRenderLayer(lm, renderLayer) {
    const mesh = lm?.mesh;
    if (!mesh) return;
    mesh.layers.set(0);
    mesh.userData.msaRoofLightGate = renderLayer === MAP_POINT_RENDER_LAYER_ABOVE
      ? MAP_POINT_RENDER_LAYER_ABOVE
      : MAP_POINT_RENDER_LAYER_BELOW;
  }

  /**
   * Build clipped pool boundary points, or null for an unconstrained radial pool.
   * @private
   * @returns {{ worldPoints: number[]|null, skip: boolean }}
   */
  _resolveGlowClipWorldPoints(clipCenter, clipRadiusPx, walls, sceneBounds, wallClipOptions, indoor) {
    if (!this.params.wallClipEnabled) {
      return { worldPoints: null, skip: false };
    }

    const elevation = wallClipOptions?.elevation;
    const physicalSegCount = this._countPhysicalGlowWallSegments(
      clipCenter,
      clipRadiusPx,
      walls,
      elevation,
    );

    const polyToWorld = (foundryPoly) => {
      const worldPoints = [];
      for (let i = 0; i < foundryPoly.length; i += 2) {
        const wp = Coordinates.toWorld(foundryPoly[i], foundryPoly[i + 1]);
        worldPoints.push(wp.x, wp.y);
      }
      return worldPoints;
    };

    const tryCompute = (options) => {
      try {
        return this._visionComputer.compute(
          clipCenter,
          clipRadiusPx,
          walls,
          sceneBounds,
          options,
        );
      } catch (_) {
        return null;
      }
    };

    const lightSenseOpts = {
      ...wallClipOptions,
      blockGeometry: false,
      sense: 'light',
    };
    if (indoor) {
      const extra = this._collectIndoorSightOnlyAdditionalSegments(
        clipCenter,
        clipRadiusPx,
        walls,
        elevation,
      );
      if (extra.length) {
        lightSenseOpts.additionalSegments = extra;
      }
    }

    const tryModes = [
      lightSenseOpts,
      { ...wallClipOptions, blockGeometry: true },
    ];

    for (const options of tryModes) {
      const foundryPoly = tryCompute(options);
      if (!foundryPoly || foundryPoly.length < 6) continue;
      if (this._isUnoccludedCircleClip(foundryPoly, clipCenter, clipRadiusPx)) continue;
      return { worldPoints: polyToWorld(foundryPoly), skip: false };
    }

    // Open interior — no physical walls in range at this elevation.
    if (physicalSegCount === 0) {
      return { worldPoints: null, skip: false };
    }

    // Clip produced only full circles (open center / clip miss) — fall back to radial pool.
    // Do not skip indoor clusters: center-room chandeliers must still emit glow.
    return { worldPoints: null, skip: false };
  }

  /**
   * True when a clip polygon is essentially the unoccluded boundary circle (wall clip missed).
   * @private
   */
  _isUnoccludedCircleClip(flatFoundryPoints, center, radiusPx) {
    if (!flatFoundryPoints || flatFoundryPoints.length < 6 || !center) return true;

    const r = Math.max(1, Number(radiusPx) || 1);
    const rMin = r * 0.9;
    const rMax = r * 1.1;
    const verts = flatFoundryPoints.length / 2;
    let onRim = 0;

    for (let i = 0; i < flatFoundryPoints.length; i += 2) {
      const dx = flatFoundryPoints[i] - center.x;
      const dy = flatFoundryPoints[i + 1] - center.y;
      const dist = Math.hypot(dx, dy);
      if (dist >= rMin && dist <= rMax) onRim += 1;
    }

    return onRim >= verts * 0.82;
  }

  /**
   * Clip glow using Foundry light rules (solid walls block; windows / proximity pass through).
   * @param {number|null} [sourceElevation]
   * @param {{ indoor?: boolean, v14LevelScoped?: boolean }} [opts]
   */
  _buildGlowWallClipOptions(sourceElevation = null, opts = {}) {
    const v14LevelScoped = opts.v14LevelScoped === true;
    const clipOpts = {
      sense: 'light',
      blockGeometry: false,
      circleSegments: 96,
    };
    try {
      const pad = window.MapShine?.lightingEffect?.params?.wallPaddingPx;
      if (typeof pad === 'number' && isFinite(pad) && pad > 0) {
        clipOpts.wallPaddingPx = Math.max(0, pad);
      }
      if (hasV14NativeLevels(canvas?.scene) && !v14LevelScoped) {
        const clipElev = Number(sourceElevation);
        if (Number.isFinite(clipElev)) {
          clipOpts.elevation = clipElev;
        } else {
          const pe = getPerspectiveElevation();
          if (Number.isFinite(pe?.losHeight)) {
            clipOpts.elevation = pe.losHeight;
          }
        }
      }
    } catch (_) {
    }
    return clipOpts;
  }

  /**
   * Resolve one or two wall-clip origins when a candle sits on a blocking wall.
   * @private
   * @returns {Array<{x:number,y:number}>}
   */
  _resolveGlowClipCenters(centerFoundry, walls, wallClipOptions) {
    const centers = [{ x: centerFoundry.x, y: centerFoundry.y }];
    if (!this.params.wallClipEnabled) return centers;

    try {
      const probes = this._visionComputer.findWallBisectProbeCenters(
        centerFoundry,
        walls,
        wallClipOptions
      );
      if (probes?.length === 2) return probes;
    } catch (_) {}

    return centers;
  }

  _createFlameMesh() {
    const THREE = window.THREE;
    if (!THREE) return;

    if (this._flameMeshBelow) {
      try { this._flameMeshBelow.removeFromParent(); } catch (_) {}
      this._flameMeshBelow = null;
    }
    if (this._flameMeshAbove) {
      try { this._flameMeshAbove.removeFromParent(); } catch (_) {}
      this._flameMeshAbove = null;
    }

    if (this._flameGeometryBelow) {
      try { this._flameGeometryBelow.dispose(); } catch (_) {}
      this._flameGeometryBelow = null;
    }
    if (this._flameGeometryAbove) {
      try { this._flameGeometryAbove.dispose(); } catch (_) {}
      this._flameGeometryAbove = null;
    }

    if (this._flameMaterial) {
      try {
        this._flameMaterial.dispose();
      } catch (_) {
      }
      this._flameMaterial = null;
    }

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

          // Teardrop: hotter and wider at the base, tighter at the tip.
          float tip = clamp(vUv.y, 0.0, 1.0);
          float tearR = r * mix(0.88, 1.12, tip * tip);

          // HDR flame zones — bright core occupies most of the sprite; outer halo is whisper-soft.
          float coreMask = smoothstep(0.78, 0.06, tearR);
          float bodyMask = smoothstep(0.98, 0.28, tearR);
          float haloMask = smoothstep(1.08, 0.58, tearR) * (1.0 - bodyMask * 0.92);

          vec3 coreRad = vec3(4.2, 3.4, 2.1);
          vec3 bodyRad = vec3(2.6, 1.75, 0.55);
          vec3 haloRad = vec3(1.15, 0.48, 0.10);

          vec3 col = haloRad * haloMask;
          col = mix(col, bodyRad, bodyMask);
          col = mix(col, coreRad, coreMask);
          col *= vColor;

          float shapeAlpha = clamp(max(coreMask, bodyMask * 0.82) + haloMask * 0.18, 0.0, 1.0);

          float flickerBase = 0.9 + 0.1 * sin(t * 0.7 + vPhase * 2.0);
          float flickerShape = sin(t) * 0.65 + sin(t * 1.73 + 2.0) * 0.35;
          float flicker = flickerBase + flickerStrength * 0.35 * flickerShape;
          flicker = max(0.55, flicker);
          float finalAlpha = shapeAlpha * uOpacity * clamp(vIntensity, 0.0, 3.0) * flicker;

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
    this._flameMaterial = material;

    const below = this._buildFlameInstancedMesh(material);
    this._flameGeometryBelow = below.geometry;
    this._flameMeshBelow = below.mesh;
    this._phaseArrayBelow = below.phaseArray;
    this._outdoorArrayBelow = below.outdoorArray;
    this._intensityArrayBelow = below.intensityArray;
    this._colorArrayBelow = below.colorArray;

    const above = this._buildFlameInstancedMesh(material);
    this._flameGeometryAbove = above.geometry;
    this._flameMeshAbove = above.mesh;
    this._phaseArrayAbove = above.phaseArray;
    this._outdoorArrayAbove = above.outdoorArray;
    this._intensityArrayAbove = above.intensityArray;
    this._colorArrayAbove = above.colorArray;

    this._applyFlameMeshRenderOrders();
  }

  /**
   * @private
   * @param {import('three').ShaderMaterial} material
   */
  _buildFlameInstancedMesh(material) {
    const THREE = window.THREE;
    const maxFlames = Math.max(0, this.params.maxFlames | 0);
    const geometry = new THREE.PlaneGeometry(1, 1, 1, 1);

    const phaseArray = new Float32Array(maxFlames);
    const outdoorArray = new Float32Array(maxFlames);
    const intensityArray = new Float32Array(maxFlames);
    const colorArray = new Float32Array(maxFlames * 3);

    const attrPhase = new THREE.InstancedBufferAttribute(phaseArray, 1);
    const attrOutdoor = new THREE.InstancedBufferAttribute(outdoorArray, 1);
    const attrIntensity = new THREE.InstancedBufferAttribute(intensityArray, 1);
    const attrColor = new THREE.InstancedBufferAttribute(colorArray, 3);

    attrPhase.setUsage(THREE.DynamicDrawUsage);
    attrOutdoor.setUsage(THREE.DynamicDrawUsage);
    attrIntensity.setUsage(THREE.DynamicDrawUsage);
    attrColor.setUsage(THREE.DynamicDrawUsage);

    geometry.setAttribute('aPhase', attrPhase);
    geometry.setAttribute('aOutdoor', attrOutdoor);
    geometry.setAttribute('aIntensity', attrIntensity);
    geometry.setAttribute('aColor', attrColor);

    const mesh = new THREE.InstancedMesh(geometry, material, maxFlames);
    mesh.frustumCulled = false;
    mesh.count = 0;

    return {
      mesh,
      geometry,
      phaseArray,
      outdoorArray,
      intensityArray,
      colorArray,
    };
  }

  _rebuildFromMapPoints() {
    if (!this._mapPointsManager) {
      this._sourceFlameCount = 0;
      this._setFlameCount(0);
      this._clusters.length = 0;
      this._clusterRegistry = [];
      this._activeClusterKeys.clear();
      this._clearGlowBuckets();
      return;
    }

    const groups = (typeof this._mapPointsManager.getGroupsByEffectForContext === 'function')
      ? (this._mapPointsManager.getGroupsByEffectForContext('candleFlame', this._activeLevelContext) || [])
      : (this._mapPointsManager.getGroupsByEffect('candleFlame') || []);
    const points = [];
    for (const g of groups) {
      if (!g?.points?.length) continue;
      const floorCtx = this._resolveGroupFloorContext(g);
      const renderLayer = this._resolveGroupRenderLayer(g);
      const emissionShape = inferMapPointGroupEmissionShape(g);

      if (emissionShape === 'point') {
        for (let pointIndex = 0; pointIndex < g.points.length; pointIndex++) {
          const p = g.points[pointIndex];
          if (!p) continue;
          if (typeof this._mapPointsManager.isGroupPointEnabled === 'function'
            && !this._mapPointsManager.isGroupPointEnabled(g.id, pointIndex)) {
            continue;
          }
          points.push({
            x: p.x,
            y: p.y,
            intensity: (g.emission && typeof g.emission.intensity === 'number') ? g.emission.intensity : 1.0,
            floorCtx,
            renderLayer,
          });
        }
        continue;
      }

      const { triples } = buildMapPointGroupSpawnPool(g);
      if (!triples) continue;
      for (let i = 0; i < triples.length; i += 3) {
        points.push({
          x: triples[i],
          y: triples[i + 1],
          intensity: triples[i + 2],
          floorCtx,
          renderLayer,
        });
      }
    }

    if (points.length === 0) {
      this._sourceFlameCount = 0;
      this._setFlameCount(0);
      this._clusters.length = 0;
      this._clusterRegistry = [];
      this._activeClusterKeys.clear();
      this._clearGlowBuckets();
      return;
    }

    this._syncSceneBounds();
    // Outdoors CPU snapshot is refreshed when the mask binding signature changes
    // (FloorCompositor._syncOutdoorsMaskConsumers) — not every update tick.

    const groundZ = this._getGroundZ();

    const buckets = new Map();
    const bucketSize = Math.max(32, this.params.glowBucketSizePx);

    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      const wx = pt.x;
      const wy = pt.y;
      const renderLayer = pt.renderLayer ?? MAP_POINT_RENDER_LAYER_BELOW;

      const outdoor = this._sampleGlowOutdoorAtWorld(wx, wy, {
        floorIndex: pt.floorCtx?.floorIndex,
        renderLayer,
      });

      const bx = Math.floor(wx / bucketSize);
      const by = Math.floor(wy / bucketSize);
      const key = `${bx},${by}:${renderLayer}`;

      let b = buckets.get(key);
      if (!b) {
        b = {
          sumX: 0,
          sumY: 0,
          sumI: 0,
          sumOutdoor: 0,
          sumClipElevation: 0,
          minOutdoor: 1.0,
          count: 0,
          floorCtx: null,
          renderLayer,
          points: [],
        };
        buckets.set(key, b);
      }
      if (!b.floorCtx && pt.floorCtx) b.floorCtx = pt.floorCtx;
      b.sumX += wx;
      b.sumY += wy;
      b.sumI += pt.intensity;
      b.sumOutdoor += outdoor;
      b.sumClipElevation += Number.isFinite(Number(pt.floorCtx?.clipElevation))
        ? Number(pt.floorCtx.clipElevation)
        : 0;
      b.minOutdoor = Math.min(b.minOutdoor, outdoor);
      b.count += 1;
      b.points.push({ ...pt, outdoor });
    }

    this._clusterRegistry = [];

    const maxBuckets = Math.max(1, this.params.glowMaxBuckets | 0);
    const belowList = [];
    const aboveList = [];
    for (const [key, b] of buckets.entries()) {
      if (!b || b.count <= 0) continue;
      const item = { key, ...b };
      if ((b.renderLayer ?? MAP_POINT_RENDER_LAYER_BELOW) === MAP_POINT_RENDER_LAYER_ABOVE) {
        aboveList.push(item);
      } else {
        belowList.push(item);
      }
    }

    belowList.sort((a, b) => (b.sumI - a.sumI) || (b.count - a.count));
    aboveList.sort((a, b) => (b.sumI - a.sumI) || (b.count - a.count));

    const takeBelow = Math.min(belowList.length, maxBuckets);
    const takeAbove = Math.min(aboveList.length, maxBuckets);

    const clipRadiusScale = Math.max(0.1, Number(this.params.wallClipRadiusScale) || 1.0);

    const pushClusterFromBucket = (b) => {
      const cxWorld = b.sumX / b.count;
      const cyWorld = b.sumY / b.count;
      const floorCtx = b.floorCtx ?? this._resolveGroupFloorContext(null);
      const bucketRenderLayer = b.renderLayer ?? MAP_POINT_RENDER_LAYER_BELOW;
      const outdoorAtCenter = this._sampleGlowOutdoorAtWorld(cxWorld, cyWorld, {
        floorIndex: floorCtx.floorIndex,
        renderLayer: bucketRenderLayer,
      });
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
      const clipElevation = b.sumClipElevation > 0
        ? (b.sumClipElevation / Math.max(1, b.count))
        : floorCtx.clipElevation;

      return {
        key: b.key,
        cxWorld,
        cyWorld,
        cxFoundry: foundryCenter.x,
        cyFoundry: foundryCenter.y,
        radiusPx,
        clipRadiusPx,
        clipElevation,
        floorCtx: {
          ...floorCtx,
          clipElevation,
        },
        intensity,
        phase,
        outdoor: outdoorForGlow,
        color: this._computeGlowColor(glow.warmth),
        renderLayer: b.renderLayer ?? MAP_POINT_RENDER_LAYER_BELOW,
      };
    };

    for (let i = 0; i < takeBelow; i++) {
      const b = belowList[i];
      const cluster = pushClusterFromBucket(b);
      this._clusterRegistry.push({
        key: b.key,
        bounds: glowCentroidBounds(cluster.cxWorld, cluster.cyWorld, cluster.radiusPx),
        points: b.points ?? [],
        cluster,
      });
    }
    for (let i = 0; i < takeAbove; i++) {
      const b = aboveList[i];
      const cluster = pushClusterFromBucket(b);
      this._clusterRegistry.push({
        key: b.key,
        bounds: glowCentroidBounds(cluster.cxWorld, cluster.cyWorld, cluster.radiusPx),
        points: b.points ?? [],
        cluster,
      });
    }

    this._clusters.length = 0;
    this._syncCandleClusterView({ createBudget: Infinity });
  }

  _setFlameCounts(belowCount, aboveCount) {
    const THREE = window.THREE;
    if (!THREE) return;

    const maxFlames = Math.max(0, this.params.maxFlames | 0);
    const below = Math.max(0, Math.min(maxFlames, belowCount | 0));
    const above = Math.max(0, Math.min(maxFlames, aboveCount | 0));
    const showFlames = !!this.params.flamesEnabled && this._effectiveShowFlames();

    if (this._flameMeshBelow) {
      this._flameMeshBelow.count = below;
      this._flameMeshBelow.visible = showFlames && below > 0;
      if (this._flameMeshBelow.instanceMatrix) {
        this._flameMeshBelow.instanceMatrix.needsUpdate = true;
      }
    }

    if (this._flameMeshAbove) {
      this._flameMeshAbove.count = above;
      this._flameMeshAbove.visible = showFlames && above > 0;
      if (this._flameMeshAbove.instanceMatrix) {
        this._flameMeshAbove.instanceMatrix.needsUpdate = true;
      }
    }

    const geos = [
      this._flameGeometryBelow?.attributes?.aPhase,
      this._flameGeometryBelow?.attributes?.aOutdoor,
      this._flameGeometryBelow?.attributes?.aIntensity,
      this._flameGeometryBelow?.attributes?.aColor,
      this._flameGeometryAbove?.attributes?.aPhase,
      this._flameGeometryAbove?.attributes?.aOutdoor,
      this._flameGeometryAbove?.attributes?.aIntensity,
      this._flameGeometryAbove?.attributes?.aColor,
    ];
    for (const attr of geos) {
      if (attr) attr.needsUpdate = true;
    }
  }

  /** @private @param {number} n Legacy single-mesh count (below band only). */
  _setFlameCount(n) {
    this._setFlameCounts(n, 0);
  }

  /** @private */
  _disposeGlowBucketEntry(entry) {
    const meshes = entry?.lightMeshes?.length
      ? entry.lightMeshes
      : (entry?.lightMesh ? [entry.lightMesh] : []);
    for (const lm of meshes) {
      try { lm?.dispose?.(); } catch (_) {}
      try { lm?.mesh?.removeFromParent?.(); } catch (_) {}
    }
  }

  /** @private */
  _forEachGlowLightMesh(entry, fn) {
    if (!entry || typeof fn !== 'function') return;
    if (entry.lightMeshes?.length) {
      for (const lm of entry.lightMeshes) fn(lm);
      return;
    }
    if (entry.lightMesh) fn(entry.lightMesh);
  }

  /** @returns {boolean} True when any live glow bucket is tagged above-overhead. */
  hasAboveOverheadGlowBuckets() {
    if (!this.params?.glowEnabled || !this._glowBuckets?.size) return false;
    for (const entry of this._glowBuckets.values()) {
      if ((entry?.renderLayer ?? MAP_POINT_RENDER_LAYER_BELOW) === MAP_POINT_RENDER_LAYER_ABOVE) {
        return true;
      }
    }
    return false;
  }

  _clearGlowBuckets() {
    if (!this._glowGroup) return;

    for (const entry of this._glowBuckets.values()) {
      this._disposeGlowBucketEntry(entry);
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
    this._outdoorsMaskFrameToken += 1;
    if (!this.params.enabled || !this._clusterRegistry?.length) return;
    this._refreshCandleOutdoorsClassification();
    this._outdoorsGlowRebuildPending = true;
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

    const allWalls = this._collectGlowClipWallSources();

    const d = canvas?.dimensions;
    const sceneX = d?.sceneX ?? 0;
    const sceneY = d?.sceneY ?? 0;
    const sceneW = d?.sceneWidth ?? d?.width ?? 1;
    const sceneH = d?.sceneHeight ?? d?.height ?? 1;

    const sceneBounds = { x: sceneX, y: sceneY, width: sceneW, height: sceneH };
    for (const c of this._clusters) {
      if (!c) continue;

      const outdoor = Math.max(0, Math.min(1, Number(c.outdoor) ?? 1));
      const indoor = this._isCandleIndoorOutdoorSample(outdoor);
      const glow = this._resolveGlowParams(null, outdoor);
      const centerFoundry = { x: c.cxFoundry, y: c.cyFoundry };
      const clipScale = Math.max(0.1, Number(this.params.wallClipRadiusScale) || 1.0);
      const radiusPx = Math.max(32, glow.radiusPx * clipScale);
      const clipRadiusPx = radiusPx;
      const floorCtx = c.floorCtx ?? null;
      const clipElevation = Number.isFinite(Number(c.clipElevation))
        ? Number(c.clipElevation)
        : floorCtx?.clipElevation;
      const v14LevelScoped = hasV14NativeLevels(canvas?.scene)
        && !!this._resolveGlowClipLevelId(floorCtx);
      const wallClipOptions = this._buildGlowWallClipOptions(clipElevation, { indoor, v14LevelScoped });
      const walls = this._filterWallsForClusterClip(allWalls, floorCtx);

      const clipCenters = this._resolveGlowClipCenters(centerFoundry, walls, wallClipOptions);
      const lightMeshes = [];

      for (const clipCenter of clipCenters) {
        const clipResult = this._resolveGlowClipWorldPoints(
          clipCenter,
          clipRadiusPx,
          walls,
          sceneBounds,
          wallClipOptions,
          indoor,
        );
        if (clipResult.skip) continue;

        const worldPoints = clipResult.worldPoints;

        const centerWorld = clipCenters.length > 1
          ? (() => {
            const wp = Coordinates.toWorld(clipCenter.x, clipCenter.y);
            return new THREE.Vector2(wp.x, wp.y);
          })()
          : new THREE.Vector2(c.cxWorld, c.cyWorld);

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
          this._tagGlowMeshRenderLayer(lm, c.renderLayer ?? MAP_POINT_RENDER_LAYER_BELOW);
          this._glowGroup.add(lm.mesh);
          lightMeshes.push(lm);
        }
      }

      if (!lightMeshes.length) continue;

      const baseColor = new THREE.Color(c.color.r, c.color.g, c.color.b);

      this._glowBuckets.set(c.key, {
        lightMesh: lightMeshes[0],
        lightMeshes,
        baseColor,
        intensity: c.intensity,
        phase: c.phase,
        outdoor: c.outdoor,
        renderLayer: c.renderLayer ?? MAP_POINT_RENDER_LAYER_BELOW,
      });
    }

    if (detached && lightScene && glowGroup) {
      try {
        lightScene.add(glowGroup);
      } catch (_) {
      }
    }
  }

  /** @private @param {number} [flameFlicker=1] */
  _neutralGlowShapeMotion(flameFlicker = 1.0) {
    return {
      flameFlicker,
      offsetX: 0,
      offsetY: 0,
      ovalX: 1,
      ovalY: 1,
      ovalAngle: 0,
      radiusMul: 1,
      innerMul: 1,
    };
  }

  /** @private */
  _shapeParam(key, fallback = 0) {
    const v = Number(this.params[key]);
    return Number.isFinite(v) ? v : fallback;
  }

  /**
   * Flame-aligned flicker + organic motion for gameplay glow pools (matches sprite shader signals).
   * @private
   * @param {number} t elapsed seconds
   * @param {number} phase per-bucket hash
   * @param {number} outdoor 0..1
   * @param {number} poolRadiusPx outer pool radius in px
   * @returns {{
   *   flameFlicker: number,
   *   offsetX: number,
   *   offsetY: number,
   *   ovalX: number,
   *   ovalY: number,
   *   ovalAngle: number,
   *   radiusMul: number,
   *   innerMul: number,
   * }}
   */
  _computeUnifiedCandleMotion(t, phase, outdoor, poolRadiusPx) {
    const indoor = this._isCandleIndoorOutdoorSample(outdoor);
    const poolR = Math.max(32, Number(poolRadiusPx) || 32);

    const rand01 = this._hash2(phase, 0.13);
    const rand01b = this._hash2(phase, 0.37);
    const sj = clamp01(Number(this.params.flameFlickerSpeedJitter) || 0);
    const stj = clamp01(Number(this.params.flameFlickerStrengthJitter) || 0);
    const speedVar = (1.0 - sj) + 2.0 * sj * rand01;
    const strengthVar = (1.0 - stj) + 2.0 * stj * rand01b;

    const flameSpeed = Math.max(0, Number(this.params.flameFlickerSpeed) || 0) * speedVar;
    const flameStrength = Math.max(0, Number(this.params.flameFlickerStrength) || 0) * strengthVar;
    const ft = t * flameSpeed + phase * 25.0;
    const flickerBase = 0.9 + 0.1 * Math.sin(ft * 0.7 + phase * 2.0);
    const flickerShape = Math.sin(ft) * 0.65 + Math.sin(ft * 1.73 + 2.0) * 0.35;
    const flameFlicker = Math.max(0.55, flickerBase + flameStrength * 0.35 * flickerShape);

    if (!this.params.glowShapeMotionEnabled) {
      return this._neutralGlowShapeMotion(flameFlicker);
    }

    const envScale = indoor
      ? Math.max(0, this._shapeParam('glowShapeIndoorScale', 0.85))
      : Math.max(0, this._shapeParam('glowShapeOutdoorScale', 1.0));
    const master = Math.max(0, this._shapeParam('glowShapeMaster', 0.32)) * envScale;
    if (master <= 1e-5) {
      return this._neutralGlowShapeMotion(flameFlicker);
    }

    const speedMul = Math.max(0.05, this._shapeParam('glowShapeSpeed', 0.85));
    const tM = t * speedMul;
    const chaosMix = clamp01(this._shapeParam('glowShapeChaos', 0.25));
    const linkFlame = this.params.glowShapeLinkFlameMotion !== false;

    let windSpeed = 0.0;
    let windDirX = 1.0;
    let windDirY = 0.0;
    if (linkFlame) {
      try {
        windSpeed = Number(weatherController?.getCurrentState?.()?.windSpeed
          ?? weatherController?.currentState?.windSpeed ?? 0.0) || 0.0;
        windSpeed = Math.max(0.0, Math.min(1.0, windSpeed));
        const state = weatherController?.getCurrentState?.() ?? weatherController?.currentState;
        const dir = state?.windDirection;
        if (dir && Number.isFinite(dir.x) && Number.isFinite(dir.y)) {
          windDirX = dir.x;
          windDirY = -dir.y;
        }
      } catch (_) {
      }
      const windLen = Math.hypot(windDirX, windDirY);
      if (windLen > 1e-4) {
        windDirX /= windLen;
        windDirY /= windLen;
      }
    }

    const draftDirX = Math.sin(phase * 9.17);
    const draftDirY = Math.cos(phase * 6.11);
    const draftLen = Math.hypot(draftDirX, draftDirY) || 1.0;

    let wAmp;
    let shapeDistort;
    let wTime;
    let sway;
    let draftiness;
    let windInfl;
    let leanX;
    let leanY;

    if (linkFlame) {
      const wobbleSpeed = Math.max(0, Number(this.params.flameWobbleSpeed) || 0);
      wTime = tM * wobbleSpeed + phase * 19.7;
      wAmp = Math.max(0, Number(this.params.flameWobble) || 0)
        * (0.35 + 0.65 * (indoor ? 0.35 : windSpeed));
      shapeDistort = Math.max(0, Number(this.params.flameShapeDistort) || 0);
      wAmp += chaosMix * 0.18;

      if (indoor) {
        sway = (Number(this.params.flameIndoorSway) || 0)
          * (Math.sin(tM * 1.4 + phase * 5.1) * 0.5 + Math.sin(tM * 2.2 + phase * 8.3) * 0.5);
      } else {
        sway = (Number(this.params.outdoorSway) || 0)
          * (Math.sin(tM * 1.7 + phase * 6.2831) * 0.5 + Math.sin(tM * 2.9 + phase * 9.1) * 0.5);
      }

      draftiness = Math.max(0, Number(this.params.draftiness) || 0);
      windInfl = Math.max(0, Number(this.params.outdoorWindInfluence) || 0);
      leanX = indoor
        ? (draftDirX / draftLen) * draftiness
        : windDirX * windInfl * windSpeed;
      leanY = indoor
        ? (draftDirY / draftLen) * draftiness * 0.35
        : windDirY * windInfl * windSpeed * 0.35;
    } else {
      wTime = tM * 4.5 + phase * 19.7;
      wAmp = chaosMix * 0.42;
      shapeDistort = 0.85;
      sway = Math.sin(tM * 1.5 + phase * 5.1) * chaosMix * 0.22;
      draftiness = 0;
      windInfl = 0;
      leanX = Math.sin(tM * 1.1 + phase * 3.7) * chaosMix * 0.12;
      leanY = Math.cos(tM * 1.3 + phase * 4.9) * chaosMix * 0.08;
    }

    const wobX = Math.sin(wTime * 1.31);
    const wobY = Math.sin(wTime * 1.77 + 0.8);
    const wobZ = Math.sin(wTime * 1.03 + phase * 4.2);

    const wanderScale = poolR * (0.022 + wAmp * 0.07 + (indoor ? draftiness : windInfl * windSpeed) * 0.04);
    const rawOffsetX = (sway + leanX * 0.55) * poolR * 0.22 + wobX * wanderScale;
    const rawOffsetY = wobY * wanderScale * 0.62 + wobZ * wanderScale * 0.28 + leanY * poolR * 0.12;

    const ovalDrive = wAmp * shapeDistort * (0.32 + flameStrength * 0.22);
    const rawOvalX = 1.0 + wobX * ovalDrive + (flameFlicker - 1.0) * 0.08;
    const rawOvalY = 1.0 - wobY * ovalDrive * 0.62 - (flameFlicker - 1.0) * 0.05;

    const baseAngle = indoor
      ? Math.atan2(draftDirY, draftDirX)
      : Math.atan2(windDirY, windDirX);
    const rawOvalAngle = baseAngle * (indoor ? 0.35 : 0.55)
      + wobZ * wAmp * shapeDistort * 0.85
      + sway * 1.6;

    const rawRadiusMul = 0.90 + flameFlicker * 0.14 + wobX * wAmp * 0.045;
    const rawInnerMul = 0.82 + flameFlicker * 0.28 + Math.max(0, wobY) * wAmp * 0.06;

    const centerShift = master * clamp01(this._shapeParam('glowShapeCenterShift', 0.38));
    const vertBias = clamp01(this._shapeParam('glowShapeCenterVertical', 0.55));
    const ovalStretch = master * clamp01(this._shapeParam('glowShapeOvalStretch', 0.28));
    const ovalRotate = master * clamp01(this._shapeParam('glowShapeOvalRotate', 0.22));
    const reachPulse = master * clamp01(this._shapeParam('glowShapeReachPulse', 0.24));
    const corePulse = master * clamp01(this._shapeParam('glowShapeCorePulse', 0.28));

    return {
      flameFlicker,
      offsetX: rawOffsetX * centerShift,
      offsetY: rawOffsetY * centerShift * (0.35 + vertBias * 0.65),
      ovalX: Math.max(0.55, 1.0 + (rawOvalX - 1.0) * ovalStretch),
      ovalY: Math.max(0.55, 1.0 + (rawOvalY - 1.0) * ovalStretch),
      ovalAngle: rawOvalAngle * ovalRotate,
      radiusMul: Math.max(0.72, 1.0 + (rawRadiusMul - 1.0) * reachPulse),
      innerMul: Math.max(0.65, 1.0 + (rawInnerMul - 1.0) * corePulse),
    };
  }

  _updateGlowFlicker(timeInfo) {
    if (!this.params.glowEnabled) return;
    if (!this._glowBuckets.size) return;

    const profile = this._resolveCandleFlameLodProfile();
    if (profile.throttleGlow) {
      this._glowFlickerSkipCounter += 1;
      if (this._glowFlickerSkipCounter % 3 !== 0) return;
    } else {
      this._glowFlickerSkipCounter = 0;
    }

    const THREE = window.THREE;
    if (!THREE) return;

    const t = timeInfo.elapsed;
    const dayNightMul = this._computeGlowDayNightIntensityMul();

    for (const entry of this._glowBuckets.values()) {
      const phase = entry.phase || 0;
      const outdoor = entry.outdoor ?? 1.0;
      const glow = this._resolveGlowParams(null, outdoor);
      const strength = glow.flickerStrength;
      const speed = glow.flickerSpeed;
      const speedJ = glow.flickerSpeedJitter;
      const strengthJ = glow.flickerStrengthJitter;
      const clipScale = Math.max(0.1, Number(this.params.wallClipRadiusScale) || 1.0);
      const baseRadiusPx = Math.max(32, glow.radiusPx * clipScale);
      const baseInnerRadiusPx = Math.max(1, baseRadiusPx * glow.innerScale);

      const motion = this._computeUnifiedCandleMotion(t, phase, outdoor, baseRadiusPx);
      const radiusPx = baseRadiusPx;
      const innerRadiusPx = baseInnerRadiusPx;

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

      const poolChaos = (0.55 * n1 + 0.30 * n2 + 0.15 * n3);
      const glowFlicker = Math.max(0.05, 1.0 + (baseAmp * strength * Math.max(0.05, strengthVar)) * poolChaos);
      const brightLink = clamp01(this._shapeParam('glowShapeBrightnessLink', 0.3));
      const flicker = Math.max(
        0.05,
        glowFlicker * (1.0 - brightLink + motion.flameFlicker * brightLink),
      );

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
      const emissionGain = this._computeGlowEmissionGain(visualMul, glow.cancel);

      this._forEachGlowLightMesh(entry, (lm) => {
        const u = lm?.material?.uniforms;
        if (!u?.uColor?.value) return;

        lm.setOuterRadiusPx?.(radiusPx);
        lm.setInnerRadiusPx?.(innerRadiusPx);
        lm.setFalloffExponent?.(glow.falloffExponent);
        lm.setEdgeSoftness?.(glow.edgeSoftness);
        lm.setOrganicFalloff?.(
          motion.offsetX,
          motion.offsetY,
          motion.ovalX,
          motion.ovalY,
          motion.ovalAngle,
        );
        lm.setPhotometricPulse?.(motion.radiusMul, motion.innerMul);

        // Hue only in uColor — intensity/flicker scales uEmissionGain (matches point-light buffer model).
        u.uColor.value.setRGB(glowColor.r, glowColor.g, glowColor.b);
        lm.setAchromaticRgb?.(false);

        if (typeof lm.setEmissionGain === 'function') {
          lm.setEmissionGain(emissionGain);
        } else if (lm.material?.uniforms?.uEmissionGain) {
          lm.material.uniforms.uEmissionGain.value = emissionGain;
        }
      });
    }
  }
}

export default CandleFlamesEffectV2;
