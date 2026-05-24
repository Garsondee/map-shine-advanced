import { createLogger } from '../../core/log.js';
import { LightingDirector } from '../../core/LightingDirector.js';
import Coordinates from '../../utils/coordinates.js';
import { getPerspectiveElevation } from '../../foundry/elevation-context.js';
import { hasV14NativeLevels } from '../../foundry/levels-scene-flags.js';
import { VisionPolygonComputer } from '../../vision/VisionPolygonComputer.js';
import { LightMesh } from '../../scene/LightMesh.js';
import {
  effectAboveOverheadOrder,
  motionAboveTokensOrder,
} from '../LayerOrderPolicy.js';

const log = createLogger('LightningEffectV2');

const DEFAULT_GROUND_Z = 1000;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Above elevated tokens in FLOOR_OVERHEAD_FX (token-manager uses intra 100 there). */
const LIGHTNING_ABOVE_TOKEN_INTRA = 200;
/** Slot within FLOOR_MOTION_TOP when drawing above overhead tiles. */
const LIGHTNING_ABOVE_OVERHEAD_INTRA = 50;

/**
 * V2 Lightning effect.
 *
 * This is a global-scoped atmospheric effect that renders procedural strike meshes
 * in the V2 render-bus scene and publishes screen-space flash data to
 * window.MapShine.environment for downstream post effects.
 */
export class LightningEffectV2 {
  constructor() {
    // Keep EffectBase-compatible fields local to avoid importing EffectComposer
    // and creating a module cycle in V2.
    this.id = 'lightning';
    this.layer = { order: 400, name: 'Environmental', requiresDepth: false };
    this.quality = 'low';
    this.enabled = true;
    this.isInitialized = false;

    // Lightning is a whole-sky atmospheric effect with no floor-specific masks.
    // Running per-floor would trigger the simulation and flash rendering N times,
    // accumulating duplicate flash geometry in the scene render target.
    this.floorScope = 'global';

    this.priority = 8;

    this.params = {
      enabled: true,

      outsideFlashEnabled: true,
      outsideFlashGain: 4.37,
      outsideFlashAttackMs: 111,
      outsideFlashDecayMs: 650,
      outsideFlashCurve: 1.6,
      outsideFlashFlickerAmount: 0.21,
      outsideFlashFlickerRate: 0.6,
      outsideFlashMaxClamp: 2.0,

      minDelayMs: 0,
      maxDelayMs: 10000,

      burstMinStrikes: 7,
      burstMaxStrikes: 16,
      strikeDurationMs: 910,

      flickerChance: 0.21,

      outerColor: { r: 0, g: 0.21440094753601224, b: 1 },
      coreColor: { r: 0.33133486883645097, g: 0, b: 0.8593836483950248 },
      brightness: 10,

      width: 30,
      taper: 0.09,
      glowStrength: 5,

      zOffset: 0,

      overheadOrder: 0,

      segments: 96,
      curveAmount: 0.62,
      macroDisplacement: 84,
      microJitter: 2,
      endPointRandomnessPx: 62,

      textureScrollSpeed: 25.1,
      coreStaticAmount: 2,
      coreStaticRange: 0.85,
      leaderFraction: 0.17,
      windDriftStrength: 0,
      branchAngleDeg: 45,

      branchChance: 1,
      branchMax: 6,
      branchLengthMin: 0.37,
      branchLengthMax: 0.83,
      branchWidthScale: 0.52,
      branchIntensityScale: 0.82,
      branchDurationScale: 0.79,

      wildArcChance: 0.0,

      audioEnabled: false,
      audioStrikePath: '',
      audioVolume: 0.7,

      originFlashEnabled: true,
      originFlashAnchor: 0,
      originFlashRadiusPx: 40,
      originFlashRadiusStrikeScale: 0.48,
      originFlashInnerRadiusScale: 0.05,
      originFlashIntensity: 1.62,
      originFlashStrikeScale: 0.73,
      originFlashDarknessCancel: 0.95,
      originFlashDarknessNightBoost: 1.6,
      originFlashFollowPointLightGain: true,
      originFlashAttenuation: 1,
      originFlashHotMix: 0.81,
      originFlashLeaderPrecursor: 0.37,
      originFlashFlickerAmount: 0.87,
      originFlashFlickerRate: 1.0,
      originFlashMinGain: 0.04,
      originFlashWallClipEnabled: true,
      originFlashWallClipRadiusScale: 0.33,
      originFlashWallPaddingPx: 1,
      originFlashAllowWindows: false
    };

    this._initialized = false;

    this.renderer = null;
    this.scene = null;
    this.camera = null;

    this._mapPointsManager = null;
    this._changeListener = null;
    this._pendingSourceRebuild = false;
    this._activeLevelContext = null;

    this._sources = [];

    this._noiseTexture = null;

    this._maxActiveStrikes = 24;
    this._maxPointsPerStrike = 96;

    this._strikePool = [];

    this._resolution = null;

    this._tempVec3A = null;
    this._tempVec3B = null;
    this._tempVec3C = null;

    this._flashStartMs = -1;
    this._flashPeak = 0.0;
    this._flashValue = 0.0;
    this._flashSeed = 0.0;

    this._lastStrikeScreenUv = null;
    this._lastStrikeDir = null;

    this._envStrikeUv = { x: 0.0, y: 0.0 };
    this._envStrikeDir = { x: 0.0, y: 0.0 };

    this._lightingEffect = null;
    this._originFlashGroup = null;
    this._tempFlashColor = null;
    this._visionComputer = new VisionPolygonComputer();
    this._hookIds = [];
    this._needsOriginFlashWallRebuild = false;
    this._lastOriginFlashWallRebuildAt = 0;
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'timing',
          label: 'Timing',
          type: 'inline',
          advanced: true,
          parameters: ['minDelayMs', 'maxDelayMs', 'burstMinStrikes', 'burstMaxStrikes', 'strikeDurationMs', 'leaderFraction', 'flickerChance']
        },
        {
          name: 'look',
          label: 'Look',
          type: 'inline',
          parameters: ['outerColor', 'coreColor', 'brightness', 'width', 'taper', 'glowStrength', 'zOffset', 'overheadOrder', 'textureScrollSpeed', 'coreStaticAmount', 'coreStaticRange', 'windDriftStrength']
        },
        {
          name: 'shape',
          label: 'Shape',
          type: 'inline',
          advanced: true,
          parameters: ['segments', 'curveAmount', 'macroDisplacement', 'microJitter', 'endPointRandomnessPx', 'branchAngleDeg', 'branchChance', 'branchMax', 'branchLengthMin', 'branchLengthMax', 'branchWidthScale', 'branchIntensityScale', 'branchDurationScale', 'wildArcChance']
        },
        {
          name: 'outsideFlash',
          label: 'Outside Flash',
          type: 'inline',
          parameters: ['outsideFlashEnabled', 'outsideFlashGain', 'outsideFlashAttackMs', 'outsideFlashDecayMs', 'outsideFlashCurve', 'outsideFlashFlickerAmount', 'outsideFlashFlickerRate', 'outsideFlashMaxClamp']
        },
        {
          name: 'originFlash',
          label: 'Origin Flash Light',
          type: 'folder',
          advanced: true,
          expanded: true,
          parameters: [
            'originFlashEnabled',
            'originFlashAnchor',
            'originFlashRadiusPx',
            'originFlashRadiusStrikeScale',
            'originFlashInnerRadiusScale',
            'originFlashIntensity',
            'originFlashStrikeScale',
            'originFlashDarknessCancel',
            'originFlashDarknessNightBoost',
            'originFlashFollowPointLightGain',
            'originFlashAttenuation',
            'originFlashHotMix',
            'originFlashLeaderPrecursor',
            'originFlashFlickerAmount',
            'originFlashFlickerRate',
            'originFlashMinGain',
            'originFlashWallClipEnabled',
            'originFlashWallClipRadiusScale',
            'originFlashWallPaddingPx',
            'originFlashAllowWindows'
          ]
        },
        {
          name: 'audio',
          label: 'Audio',
          type: 'inline',
          advanced: true,
          parameters: ['audioEnabled', 'audioStrikePath', 'audioVolume']
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },

        outsideFlashEnabled: { type: 'boolean', default: true, label: 'Flash Enabled' },
        outsideFlashGain: { type: 'slider', min: 0, max: 5, step: 0.01, default: 4.37, label: 'Flash Gain' },
        outsideFlashAttackMs: { type: 'slider', min: 0, max: 150, step: 1, default: 111, label: 'Attack (ms)' },
        outsideFlashDecayMs: { type: 'slider', min: 50, max: 2500, step: 10, default: 650, label: 'Decay (ms)' },
        outsideFlashCurve: { type: 'slider', min: 0.25, max: 4, step: 0.01, default: 1.6, label: 'Decay Curve' },
        outsideFlashFlickerAmount: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.21, label: 'Flicker Amount' },
        outsideFlashFlickerRate: { type: 'slider', min: 0, max: 40, step: 0.1, default: 0.6, label: 'Flicker Rate' },
        outsideFlashMaxClamp: { type: 'slider', min: 0, max: 10, step: 0.05, default: 2.0, label: 'Flash Clamp' },

        minDelayMs: { type: 'slider', min: 0, max: 5000, step: 50, default: 0, label: 'Min Delay (ms)' },
        maxDelayMs: { type: 'slider', min: 0, max: 10000, step: 50, default: 10000, label: 'Max Delay (ms)' },

        burstMinStrikes: { type: 'slider', min: 1, max: 10, step: 1, default: 7, label: 'Restrikes Min', tooltip: 'Minimum rapid flashes along the same plasma channel per burst.' },
        burstMaxStrikes: { type: 'slider', min: 1, max: 16, step: 1, default: 16, label: 'Restrikes Max', tooltip: 'Maximum rapid flashes along the same plasma channel per burst.' },
        strikeDurationMs: { type: 'slider', min: 20, max: 2400, step: 10, default: 910, label: 'Strike Duration (ms)' },
        leaderFraction: { type: 'slider', min: 0.1, max: 0.35, step: 0.01, default: 0.17, label: 'Leader Phase', tooltip: 'Fraction of strike duration spent searching downward before the return stroke connects.' },
        flickerChance: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.21, label: 'Flicker Chance' },

        outerColor: { type: 'color', default: { r: 0, g: 0.21440094753601224, b: 1 }, label: 'Outer Color' },
        coreColor: { type: 'color', default: { r: 0.33133486883645097, g: 0, b: 0.8593836483950248 }, label: 'Core Color' },
        brightness: { type: 'slider', min: 0, max: 10, step: 0.05, default: 10, label: 'Brightness' },
        width: { type: 'slider', min: 1, max: 120, step: 1, default: 30, label: 'Width (px-ish)' },
        taper: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.09, label: 'Taper' },
        glowStrength: { type: 'slider', min: 0, max: 5, step: 0.05, default: 5, label: 'Glow Strength' },
        zOffset: { type: 'slider', min: 0, max: 50, step: 0.25, default: 0, label: 'Z Offset' },
        overheadOrder: {
          type: 'list',
          label: 'Overhead Order',
          options: {
            'Below Overhead': 0,
            'Above Overhead': 1
          },
          default: 0,
          tooltip: 'Always draws above tokens. Below Overhead = under roof tiles; Above Overhead = top motion band.'
        },
        textureScrollSpeed: { type: 'slider', min: 0, max: 30, step: 0.1, default: 25.1, label: 'Texture Scroll Speed' },
        coreStaticAmount: { type: 'slider', min: 0, max: 2, step: 0.01, default: 2, label: 'Core Static Amount', tooltip: 'Crackling sparkle intensity on the bright core near the bolt base.' },
        coreStaticRange: { type: 'slider', min: 0.15, max: 0.85, step: 0.01, default: 0.85, label: 'Core Static Range', tooltip: 'How far along the bolt (from base) the core static reaches.' },
        windDriftStrength: { type: 'slider', min: 0, max: 1.5, step: 0.01, default: 0, label: 'Wind Drift', tooltip: 'Slow plasma ribbon drift after the return stroke connects.' },

        segments: { type: 'slider', min: 4, max: 96, step: 1, default: 96, label: 'Segments' },
        curveAmount: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.62, label: 'Curve Amount' },
        macroDisplacement: { type: 'slider', min: 0, max: 400, step: 1, default: 84, label: 'Fractal Chaos', tooltip: 'Root zigzag strength relative to bolt length. Values tuned for midpoint-displacement paths.' },
        microJitter: { type: 'slider', min: 0, max: 120, step: 1, default: 2, label: 'Micro Jitter' },
        endPointRandomnessPx: { type: 'slider', min: 0, max: 400, step: 1, default: 62, label: 'Endpoint Randomness' },
        branchAngleDeg: { type: 'slider', min: 15, max: 60, step: 1, default: 45, label: 'Branch Angle', tooltip: 'Acute fork angle off the parent channel tangent.' },

        branchChance: { type: 'slider', min: 0, max: 1, step: 0.01, default: 1, label: 'Branch Chance' },
        branchMax: { type: 'slider', min: 0, max: 6, step: 1, default: 6, label: 'Branch Max' },
        branchLengthMin: { type: 'slider', min: 0.05, max: 1, step: 0.01, default: 0.37, label: 'Branch Length Min' },
        branchLengthMax: { type: 'slider', min: 0.05, max: 1.5, step: 0.01, default: 0.83, label: 'Branch Length Max' },
        branchWidthScale: { type: 'slider', min: 0.05, max: 1, step: 0.01, default: 0.52, label: 'Branch Width Scale' },
        branchIntensityScale: { type: 'slider', min: 0.05, max: 1, step: 0.01, default: 0.82, label: 'Branch Intensity Scale' },
        branchDurationScale: { type: 'slider', min: 0.1, max: 1, step: 0.01, default: 0.79, label: 'Branch Duration Scale' },

        wildArcChance: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.0, label: 'Wild Arc Chance' },

        originFlashEnabled: { type: 'boolean', default: true, label: 'Enabled', tooltip: 'Localized LightMesh at the strike origin that punches through darkness like candle glow.' },
        originFlashAnchor: {
          type: 'list',
          label: 'Anchor Point',
          options: {
            'Bolt Start': 0,
            'Strike Impact': 1,
            'Both Ends': 2
          },
          default: 0,
          tooltip: 'World point(s) where the origin flash light is placed along the bolt path.'
        },
        originFlashRadiusPx: { type: 'slider', min: 40, max: 2400, step: 10, default: 40, label: 'Radius (px)' },
        originFlashRadiusStrikeScale: { type: 'slider', min: 0, max: 1.5, step: 0.01, default: 0.48, label: 'Radius Strike Scale', tooltip: 'How much brighter/larger strikes expand the flash radius.' },
        originFlashInnerRadiusScale: { type: 'slider', min: 0.05, max: 0.6, step: 0.01, default: 0.05, label: 'Inner Radius Scale' },
        originFlashIntensity: { type: 'slider', min: 0, max: 4, step: 0.01, default: 1.62, label: 'Light Intensity' },
        originFlashStrikeScale: { type: 'slider', min: 0, max: 3, step: 0.01, default: 0.73, label: 'Strike Intensity Scale', tooltip: 'Scales the flash with each bolt\'s map-point intensity envelope.' },
        originFlashDarknessCancel: { type: 'slider', min: 0, max: 12, step: 0.05, default: 0.95, label: 'Darkness Cancel', tooltip: 'HDR emission gain driving compose darkness punch (higher = cuts darkness harder).' },
        originFlashDarknessNightBoost: { type: 'slider', min: 1, max: 4, step: 0.01, default: 1.6, label: 'Night Cancel Boost' },
        originFlashFollowPointLightGain: { type: 'boolean', default: true, label: 'Follow Point Light Gain' },
        originFlashAttenuation: { type: 'slider', min: 0.05, max: 1, step: 0.01, default: 1, label: 'Edge Attenuation' },
        originFlashHotMix: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.81, label: 'Hot Core Mix', tooltip: 'Blend bolt colors toward white-hot at peak intensity.' },
        originFlashLeaderPrecursor: { type: 'slider', min: 0, max: 0.5, step: 0.01, default: 0.37, label: 'Leader Precursor', tooltip: 'Dim origin glow while the stepped leader is still searching.' },
        originFlashFlickerAmount: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.87, label: 'Flicker Amount' },
        originFlashFlickerRate: { type: 'slider', min: 0, max: 40, step: 0.1, default: 1.0, label: 'Flicker Rate' },
        originFlashMinGain: { type: 'slider', min: 0, max: 0.5, step: 0.01, default: 0.04, label: 'Min Visible Gain' },
        originFlashWallClipEnabled: { type: 'boolean', default: true, label: 'Wall Clip', tooltip: 'Clip origin flash to wall line-of-sight (prevents light bleeding through walls).' },
        originFlashWallClipRadiusScale: { type: 'slider', min: 0.1, max: 2.0, step: 0.01, default: 0.33, label: 'Clip Radius Scale', tooltip: 'Radius used for wall polygon raycast (can differ from visual radius).' },
        originFlashWallPaddingPx: { type: 'slider', min: 0, max: 240, step: 1, default: 1, label: 'Wall Padding (px)', tooltip: 'Expands blocking walls outward so light does not leak through thin geometry.' },
        originFlashAllowWindows: { type: 'boolean', default: false, label: 'Allow Window Light', tooltip: 'When enabled, uses Foundry light rules so flashes can pass through windows but not solid walls.' },

        audioEnabled: { type: 'boolean', default: false, label: 'Audio Enabled' },
        audioStrikePath: { type: 'string', default: '', label: 'Strike Sound Path' },
        audioVolume: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.7, label: 'Volume' }
      }
    };
  }

  applyParamChange(paramId, value) {
    if (paramId === 'enabled') {
      this.enabled = !!value;
      this.params.enabled = !!value;
      return;
    }
    if (this.params && Object.prototype.hasOwnProperty.call(this.params, paramId)) {
      this.params[paramId] = value;
    }

    if (paramId === 'overheadOrder') {
      this._applyOverheadOrderToMeshes();
    }

    if (paramId === 'originFlashEnabled') {
      this._syncOriginFlashGroupVisibility();
    }

    if (
      paramId === 'originFlashWallClipEnabled'
      || paramId === 'originFlashWallClipRadiusScale'
      || paramId === 'originFlashWallPaddingPx'
      || paramId === 'originFlashAllowWindows'
    ) {
      this._needsOriginFlashWallRebuild = true;
    }

    // Timing parameters influence burst scheduling; rebuild sources so scene-load
    // restored settings take effect immediately without requiring point edits.
    if (
      paramId === 'minDelayMs' ||
      paramId === 'maxDelayMs' ||
      paramId === 'burstMinStrikes' ||
      paramId === 'burstMaxStrikes'
    ) {
      this._requestSourceRebuild();
    }
  }

  initialize(renderer, scene, camera) {
    const THREE = window.THREE;
    if (!THREE) return;

    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    this._resolution = new THREE.Vector2(1, 1);
    this.renderer.getDrawingBufferSize(this._resolution);

    this._tempVec3A = new THREE.Vector3();
    this._tempVec3B = new THREE.Vector3();
    this._tempVec3C = new THREE.Vector3();

    this._lastStrikeScreenUv = new THREE.Vector2(0.5, 0.5);
    this._lastStrikeDir = new THREE.Vector2(0.0, -1.0);

    this._flashSeed = Math.random();

    this._noiseTexture = this._createNoiseTexture();
    this._originFlashGroup = new THREE.Group();
    this._originFlashGroup.name = 'LightningOriginFlash';
    this._tempFlashColor = new THREE.Color(1, 1, 1);
    this._tryAttachOriginFlashGroup();
    this._registerWallHooks();

    this._createStrikePool();

    // FloorRenderBus may rebuild/clear children after effect initialization.
    // Keep a reattach path so strike meshes remain in the active bus scene.
    this.ensureMeshesAttached(scene);

    this._applyOverheadOrderToMeshes();

    // Defer source rebuild to update() so startup wiring/state-restore order
    // cannot leave lightning with stale or empty source data.
    this._requestSourceRebuild();

    this._initialized = true;
    this.isInitialized = true;
    log.info('LightningEffectV2 initialized');
  }

  /**
   * Ensure pooled strike meshes are attached to the current render scene.
   * Safe to call each frame; it only re-adds detached meshes.
   * @param {THREE.Scene|null} [sceneOverride]
   */
  ensureMeshesAttached(sceneOverride = null) {
    const targetScene = sceneOverride || this.scene;
    if (!targetScene || !this._strikePool?.length) return;

    for (let i = 0; i < this._strikePool.length; i++) {
      const strike = this._strikePool[i];
      const mesh = strike?.mesh;
      if (!mesh) continue;
      if (mesh.parent === targetScene) continue;
      if (mesh.parent) mesh.parent.remove(mesh);
      targetScene.add(mesh);
    }
  }

  onResize(width, height) {
    if (!this._resolution) return;
    this._resolution.set(width, height);
  }

  setMapPointsSources(manager) {
    const prevManager = this._mapPointsManager;
    if (this._changeListener && prevManager) {
      prevManager.removeChangeListener(this._changeListener);
    }

    this._mapPointsManager = manager || null;

    this._requestSourceRebuild();

    this._changeListener = () => this._requestSourceRebuild();
    if (this._mapPointsManager) {
      this._mapPointsManager.addChangeListener(this._changeListener);
    }
  }

  setActiveLevelContext(context = null) {
    this._activeLevelContext = context ?? window.MapShine?.activeLevelContext ?? null;
    this._applyOverheadOrderToMeshes();
    this._requestSourceRebuild();
  }

  /**
   * Wire into LightingEffectV2 so origin flash LightMeshes render into the light buffer.
   * @param {import('./LightingEffectV2.js').LightingEffectV2|null} lightingEffect
   */
  setLightingEffect(lightingEffect) {
    this._lightingEffect = lightingEffect || null;
    this._tryAttachOriginFlashGroup();
    this._syncOriginFlashGroupVisibility();
  }

  update(timeInfo) {
    if (!this._initialized) return;

    const nowMs = timeInfo.elapsed * 1000;

    if (this._pendingSourceRebuild) {
      this._rebuildSources(nowMs);
      this._pendingSourceRebuild = false;
    }

    if (!this.enabled || !this.params.enabled) {
      this._hideAllStrikes();
      this._setFlash(0.0, timeInfo);
      this._syncOriginFlashGroupVisibility();
      return;
    }

    this._tryAttachOriginFlashGroup();

    if (
      this._needsOriginFlashWallRebuild
      && (timeInfo.elapsed - this._lastOriginFlashWallRebuildAt) > 0.12
    ) {
      this._invalidateOriginFlashWallClip();
      this._needsOriginFlashWallRebuild = false;
      this._lastOriginFlashWallRebuildAt = timeInfo.elapsed;
    }

    for (let i = 0; i < this._sources.length; i++) {
      const src = this._sources[i];

      if (nowMs < src.nextBurstAt) continue;

      if (!src.burstActive) {
        src.burstActive = true;
        src.nextStrikeAt = nowMs;
      }

      if (src.burstActive && nowMs >= src.nextStrikeAt) {
        const isWild = this._randFloat(src.rng) < this.params.wildArcChance;
        this._spawnStrike(src, timeInfo, isWild);
        src.burstActive = false;
        src.nextBurstAt = nowMs + this._randFloatRange(src.rng, this.params.minDelayMs, this.params.maxDelayMs);
      }
    }

    for (let i = 0; i < this._strikePool.length; i++) {
      const strike = this._strikePool[i];
      if (!strike.active) continue;

      const t = (nowMs - strike.startTimeMs) / Math.max(1, strike.durationMs);
      if (t >= 1.0) {
        this._deactivateStrike(strike);
        continue;
      }

      const envelope = this._computeStrikeEnvelope(strike, t, timeInfo);
      let intensity = envelope.env * strike.baseIntensity;

      if (envelope.triggerReturnFlash && !strike.isBranch) {
        strike.returnStrokeTriggered = true;
        this._tempVec3A.set(strike.flashStartX, strike.flashStartY, strike.flashStartZ);
        this._tempVec3B.set(strike.flashEndX, strike.flashEndY, strike.flashEndZ);
        this._registerStrikeForFlash(this._tempVec3A, this._tempVec3B, intensity, timeInfo);
      }

      strike.material.uniforms.uTime.value = timeInfo.elapsed;
      strike.material.uniforms.uIntensity.value = intensity;
      strike.material.uniforms.uGrowth.value = envelope.growth;
      strike.material.uniforms.uStrikeAge01.value = envelope.age01;
      strike.material.uniforms.uResolution.value.copy(this._resolution);

      strike.material.uniforms.uWidth.value = this.params.width * (strike.widthScale ?? 1.0);
      strike.material.uniforms.uTaper.value = this.params.taper;
      strike.material.uniforms.uBrightness.value = this.params.brightness;
      strike.material.uniforms.uGlowStrength.value = this.params.glowStrength;
      strike.material.uniforms.uTextureScrollSpeed.value = this.params.textureScrollSpeed;
      strike.material.uniforms.uCoreStaticAmount.value = this.params.coreStaticAmount;
      strike.material.uniforms.uCoreStaticRange.value = this.params.coreStaticRange;
      strike.material.uniforms.uWindDriftStrength.value = this.params.windDriftStrength;
      strike.material.uniforms.uWindDir.value.set(strike.windDirX, strike.windDirY);
      strike.material.uniforms.uOuterColor.value.set(this.params.outerColor.r, this.params.outerColor.g, this.params.outerColor.b);
      strike.material.uniforms.uCoreColor.value.set(this.params.coreColor.r, this.params.coreColor.g, this.params.coreColor.b);

      strike.mesh.visible = intensity > 0.001;

      if (!strike.isBranch) {
        this._updateStrikeOriginFlash(strike, intensity, envelope, timeInfo);
      } else {
        this._disposeStrikeOriginFlash(strike);
      }
    }

    this._syncOriginFlashGroupVisibility();
    this._updateFlash(timeInfo);
  }

  onFloorChange(_maxFloorIndex) {
    // Re-evaluate source groups and render-order band for the active floor.
    this.setActiveLevelContext(window.MapShine?.activeLevelContext ?? null);
  }

  render() {
    // Lightning uses persistent scene meshes and updates uniforms in update().
    // No explicit post pass render call is required here.
  }

  wantsContinuousRender() {
    if (!this.enabled || !this.params.enabled) return false;
    if (this._sources.length > 0) return true;
    for (let i = 0; i < this._strikePool.length; i++) {
      if (this._strikePool[i]?.active) return true;
    }
    return false;
  }

  _ensureEnvironment() {
    const ms = window.MapShine;
    if (!ms) return null;
    if (!ms.environment) ms.environment = {};
    return ms.environment;
  }

  _setFlash(v, timeInfo) {
    const env = this._ensureEnvironment();
    this._flashValue = v;
    if (env) {
      env.lightningFlash = v;
      env.lightningFlash01 = (this.params.outsideFlashMaxClamp > 0.0) ? Math.max(0.0, Math.min(1.0, v / this.params.outsideFlashMaxClamp)) : 0.0;
      env.lightningStrikeUv = this._envStrikeUv;
      env.lightningStrikeDir = this._envStrikeDir;
      env.lightningStrikeTime = timeInfo.elapsed;
    }
  }

  _updateFlash(timeInfo) {
    if (!this.params.outsideFlashEnabled) {
      if (this._flashValue !== 0.0) this._setFlash(0.0, timeInfo);
      return;
    }

    const nowMs = timeInfo.elapsed * 1000;
    if (this._flashStartMs < 0) {
      if (this._flashValue !== 0.0) this._setFlash(0.0, timeInfo);
      return;
    }

    const attackMs = Math.max(0.0, this.params.outsideFlashAttackMs);
    const decayMs = Math.max(1.0, this.params.outsideFlashDecayMs);
    const curve = Math.max(0.01, this.params.outsideFlashCurve);
    const dtMs = Math.max(0.0, nowMs - this._flashStartMs);

    let env = 0.0;
    if (attackMs > 0.0 && dtMs < attackMs) {
      env = dtMs / attackMs;
    } else {
      const t = (dtMs - attackMs) / decayMs;
      env = Math.pow(Math.max(0.0, 1.0 - t), curve);
    }

    let flash = env * Math.max(0.0, this._flashPeak) * Math.max(0.0, this.params.outsideFlashGain);

    const flickAmt = Math.max(0.0, Math.min(1.0, this.params.outsideFlashFlickerAmount));
    if (flickAmt > 0.0) {
      const rate = Math.max(0.0, this.params.outsideFlashFlickerRate);
      const w = 6.283185307179586 * rate;
      const flick = 0.5 + 0.5 * Math.sin(timeInfo.elapsed * w + this._flashSeed * 31.7);
      flash *= (1.0 - flickAmt) + flickAmt * flick;
    }

    const clampV = Math.max(0.0, this.params.outsideFlashMaxClamp);
    if (clampV > 0.0) flash = Math.min(flash, clampV);

    if (env <= 0.0001) {
      this._flashStartMs = -1;
      this._flashPeak = 0.0;
      flash = 0.0;
    }

    if (flash !== this._flashValue) {
      this._setFlash(flash, timeInfo);
    }
  }

  _registerStrikeForFlash(start, end, intensity, timeInfo) {
    const THREE = window.THREE;
    if (!THREE || !this.camera || !this._tempVec3C) return;

    const dirX = end.x - start.x;
    const dirY = end.y - start.y;
    const len = Math.max(1e-4, Math.sqrt(dirX * dirX + dirY * dirY));

    if (this._lastStrikeDir) {
      this._lastStrikeDir.set(dirX / len, dirY / len);
    }

    if (this._envStrikeDir) {
      this._envStrikeDir.x = dirX / len;
      this._envStrikeDir.y = dirY / len;
    }

    // Project the end point to screen UV so downstream screen-space effects can react.
    this._tempVec3C.set(end.x, end.y, end.z);
    this._tempVec3C.project(this.camera);

    const u = this._tempVec3C.x * 0.5 + 0.5;
    const v = this._tempVec3C.y * 0.5 + 0.5;

    if (this._lastStrikeScreenUv) {
      this._lastStrikeScreenUv.set(u, v);
    }

    if (this._envStrikeUv) {
      this._envStrikeUv.x = u;
      this._envStrikeUv.y = v;
    }

    // Trigger/refresh the outside flash envelope.
    this._flashStartMs = timeInfo.elapsed * 1000;
    this._flashPeak = Math.max(this._flashPeak, Math.max(0.0, intensity));
  }

  dispose() {
    if (this._changeListener && this._mapPointsManager) {
      this._mapPointsManager.removeChangeListener(this._changeListener);
    }

    for (const [hook, id] of this._hookIds) {
      try { Hooks.off(hook, id); } catch (_) {}
    }
    this._hookIds.length = 0;

    for (let i = 0; i < this._strikePool.length; i++) {
      const s = this._strikePool[i];
      try {
        if (s.mesh && s.mesh.parent) s.mesh.parent.remove(s.mesh);
        if (s.geometry) s.geometry.dispose();
        if (s.material) s.material.dispose();
      } catch (_) {
      }
    }

    this._strikePool.length = 0;

    this._clearAllOriginFlashes();
    if (this._originFlashGroup) {
      try { this._originFlashGroup.removeFromParent(); } catch (_) {}
      this._originFlashGroup = null;
    }

    if (this._noiseTexture) {
      try { this._noiseTexture.dispose(); } catch (_) {}
      this._noiseTexture = null;
    }

    this._initialized = false;
    this.isInitialized = false;
  }

  _requestSourceRebuild() {
    this._pendingSourceRebuild = true;
  }

  _getGroundZ() {
    const sc = window.MapShine?.sceneComposer;
    return (sc && typeof sc.groundZ === 'number') ? sc.groundZ : DEFAULT_GROUND_Z;
  }

  _toWorldPoint(point) {
    const THREE = window.THREE;
    const v = new THREE.Vector3(point.x, point.y, 0);
    v.z = this._getGroundZ() + (this.params?.zOffset ?? 2.0);
    return v;
  }

  _rebuildSources(nowMsOverride = null) {
    this._sources.length = 0;

    if (!this._mapPointsManager) return;

    const groups = (typeof this._mapPointsManager.getGroupsByEffectForContext === 'function')
      ? (this._mapPointsManager.getGroupsByEffectForContext('lightning', this._activeLevelContext) || [])
      : (this._mapPointsManager.getGroupsByEffect('lightning') || []);
    if (groups.length === 0) return;

    const THREE = window.THREE;
    if (!THREE) return;

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (!g || g.isBroken) continue;
      if (!g.points || g.points.length < 2) continue;

      const isLine = g.type === 'line';
      const isPointLine = g.type === 'point' && g.points.length >= 2;
      if (!isLine && !isPointLine) continue;

      const start = this._toWorldPoint(g.points[0]);
      const end = this._toWorldPoint(g.points[g.points.length - 1]);

      const rng = { state: this._hashStringToUint(g.id || String(i)) };

      this._sources.push({
        id: g.id,
        startX: start.x,
        startY: start.y,
        startZ: start.z,
        endX: end.x,
        endY: end.y,
        endZ: end.z,
        intensity: g.emission?.intensity ?? 1.0,
        rng,
        nextBurstAt: 0,
        burstActive: false,
        nextStrikeAt: 0
      });
    }

    const nowMs = Number.isFinite(nowMsOverride)
      ? nowMsOverride
      : ((window.MapShine?.timeManager?.elapsed ?? 0) * 1000);
    for (let i = 0; i < this._sources.length; i++) {
      const s = this._sources[i];
      s.nextBurstAt = nowMs + this._randFloatRange(s.rng, 0, Math.max(0, this.params.maxDelayMs));
    }

    log.info(`Lightning sources rebuilt: ${this._sources.length}`);
  }

  _hideAllStrikes() {
    for (let i = 0; i < this._strikePool.length; i++) {
      this._deactivateStrike(this._strikePool[i]);
    }
  }

  _createStrikePool() {
    const THREE = window.THREE;
    if (!THREE) return;

    this._strikePool.length = 0;

    for (let i = 0; i < this._maxActiveStrikes; i++) {
      const { geometry, material } = this._createStrikeMeshResources();
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.visible = false;
      if (this.scene) {
        this.scene.add(mesh);
      }

      const rng = { state: this._hashStringToUint(`strike_${i}`) ^ 0x9e3779b9 };

      this._strikePool.push({
        active: false,
        mesh,
        geometry,
        material,
        rng,
        seed: this._randFloat(rng),
        startTimeMs: 0,
        durationMs: 0,
        baseIntensity: 1.0,
        widthScale: 1.0,
        pointCount: 0,
        restrikeCount: 4,
        leaderFrac: 0.2,
        growthSpeed: 1.0,
        isBranch: false,
        parentStrike: null,
        windDirX: 0.0,
        windDirY: 0.0,
        returnStrokeTriggered: false,
        originFlashMeshes: null,
        arrays: geometry.userData._arrays
      });
    }
  }

  /**
   * Active compositor floor for render-order bands (matches token-manager V2).
   * @returns {number}
   * @private
   */
  _resolveActiveFloorIndex() {
    try {
      const floorStack = window.MapShine?.effectComposer?._floorCompositorV2?.floorStack
        ?? window.MapShine?.floorStack
        ?? null;
      const activeIdx = Number(floorStack?.getActiveFloor?.()?.index);
      if (Number.isFinite(activeIdx)) return Math.max(0, activeIdx);

      const ctx = this._activeLevelContext ?? window.MapShine?.activeLevelContext ?? null;
      const floors = floorStack?.getFloors?.() ?? [];
      if (!ctx || !Array.isArray(floors) || floors.length === 0) return 0;

      const b = Number(ctx.bottom);
      const t = Number(ctx.top);
      if (!Number.isFinite(b)) return 0;

      const hasFiniteTop = Number.isFinite(t);
      const mid = hasFiniteTop ? ((b + t) / 2) : b;
      let bestIdx = 0;
      let foundExact = false;
      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        const fMin = Number(f?.elevationMin);
        const fMax = Number(f?.elevationMax);
        if (fMin === b && (!hasFiniteTop || fMax === t)) {
          return i;
        }
        if (!foundExact && mid >= fMin && mid <= fMax) {
          bestIdx = i;
        }
      }
      return bestIdx;
    } catch (_) {
      return 0;
    }
  }

  /**
   * Map overheadOrder to LayerOrderPolicy bands. Always above token sprites;
   * "below overhead" sits in FLOOR_OVERHEAD_FX, "above overhead" in MOTION_TOP.
   * @private
   */
  _applyOverheadOrderToMeshes() {
    const floorIndex = this._resolveActiveFloorIndex();
    const order = (this.params && typeof this.params.overheadOrder === 'number') ? this.params.overheadOrder : 0;
    const lightningOrder = order > 0.5
      ? motionAboveTokensOrder(floorIndex, LIGHTNING_ABOVE_OVERHEAD_INTRA)
      : effectAboveOverheadOrder(floorIndex, LIGHTNING_ABOVE_TOKEN_INTRA);

    for (let i = 0; i < this._strikePool.length; i++) {
      const s = this._strikePool[i];
      if (s?.mesh) {
        s.mesh.renderOrder = lightningOrder;
      }
    }
  }

  _createStrikeMeshResources() {
    const THREE = window.THREE;

    const pointCapacity = this._maxPointsPerStrike;
    const vertCount = pointCapacity * 2;

    const positions = new Float32Array(vertCount * 3);
    const prevPos = new Float32Array(vertCount * 3);
    const nextPos = new Float32Array(vertCount * 3);
    const side = new Float32Array(vertCount);
    const uvOffset = new Float32Array(vertCount);

    for (let i = 0; i < pointCapacity; i++) {
      const u = pointCapacity <= 1 ? 0 : i / (pointCapacity - 1);
      const v0 = i * 2;
      const v1 = v0 + 1;
      side[v0] = -1.0;
      side[v1] = 1.0;
      uvOffset[v0] = u;
      uvOffset[v1] = u;
    }

    const indices = new Uint16Array((pointCapacity - 1) * 6);
    let idx = 0;
    for (let i = 0; i < pointCapacity - 1; i++) {
      const a0 = i * 2;
      const a1 = a0 + 1;
      const b0 = (i + 1) * 2;
      const b1 = b0 + 1;

      indices[idx++] = a0;
      indices[idx++] = a1;
      indices[idx++] = b0;

      indices[idx++] = a1;
      indices[idx++] = b1;
      indices[idx++] = b0;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('prevPos', new THREE.BufferAttribute(prevPos, 3));
    geometry.setAttribute('nextPos', new THREE.BufferAttribute(nextPos, 3));
    geometry.setAttribute('side', new THREE.BufferAttribute(side, 1));
    geometry.setAttribute('uvOffset', new THREE.BufferAttribute(uvOffset, 1));

    geometry.setDrawRange(0, 0);

    geometry.userData._arrays = { positions, prevPos, nextPos, side, uvOffset, pointCapacity };

    const material = this._createLightningMaterial();

    return { geometry, material };
  }

  _createLightningMaterial() {
    const THREE = window.THREE;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0.0 },
        uResolution: { value: this._resolution || new THREE.Vector2(1, 1) },
        uWidth: { value: this.params.width },
        uTaper: { value: this.params.taper },
        uIntensity: { value: 0.0 },
        uOuterColor: { value: new THREE.Vector3(this.params.outerColor.r, this.params.outerColor.g, this.params.outerColor.b) },
        uCoreColor: { value: new THREE.Vector3(this.params.coreColor.r, this.params.coreColor.g, this.params.coreColor.b) },
        uBrightness: { value: this.params.brightness },
        uGlowStrength: { value: this.params.glowStrength },
        uTextureScrollSpeed: { value: this.params.textureScrollSpeed },
        uCoreStaticAmount: { value: this.params.coreStaticAmount },
        uCoreStaticRange: { value: this.params.coreStaticRange },
        uGrowth: { value: 1.0 },
        uStrikeAge01: { value: 0.0 },
        uWindDir: { value: new THREE.Vector2(0.0, 0.0) },
        uWindDriftStrength: { value: this.params.windDriftStrength },
        uNoiseMap: { value: this._noiseTexture }
      },
      vertexShader: `
        attribute vec3 prevPos;
        attribute vec3 nextPos;
        attribute float side;
        attribute float uvOffset;

        uniform vec2 uResolution;
        uniform float uWidth;
        uniform float uTaper;
        uniform float uStrikeAge01;
        uniform float uTime;
        uniform vec2 uWindDir;
        uniform float uWindDriftStrength;

        varying vec2 vUv;
        varying float vAlong;
        varying float vTipFade;

        void main() {
          vec4 clipPrev = projectionMatrix * modelViewMatrix * vec4(prevPos, 1.0);
          vec4 clipCurr = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          vec4 clipNext = projectionMatrix * modelViewMatrix * vec4(nextPos, 1.0);

          vec2 p = clipPrev.xy / max(1e-6, clipPrev.w);
          vec2 a = clipCurr.xy / max(1e-6, clipCurr.w);
          vec2 b = clipNext.xy / max(1e-6, clipNext.w);

          vec2 dirPrevPxRaw = (a - p) * uResolution;
          vec2 dirNextPxRaw = (b - a) * uResolution;

          float prevLen2 = dot(dirPrevPxRaw, dirPrevPxRaw);
          float nextLen2 = dot(dirNextPxRaw, dirNextPxRaw);
          if (prevLen2 < 1e-6) dirPrevPxRaw = dirNextPxRaw;
          if (nextLen2 < 1e-6) dirNextPxRaw = dirPrevPxRaw;

          vec2 dirPrev = normalize(dirPrevPxRaw);
          vec2 dirNext = normalize(dirNextPxRaw);

          vec2 nPrev = vec2(-dirPrev.y, dirPrev.x);
          vec2 nNext = vec2(-dirNext.y, dirNext.x);

          vec2 miter = nPrev + nNext;
          float miterLen2 = dot(miter, miter);
          if (miterLen2 < 1e-6) {
            miter = nNext;
          } else {
            miter *= inversesqrt(miterLen2);
          }

          float denom = max(0.25, abs(dot(miter, nNext)));
          float miterScale = min(2.25, 1.0 / denom);
          vec2 normalPx = miter * miterScale;

          float taperT = pow(uvOffset, max(0.001, uTaper));
          taperT = taperT * taperT * (3.0 - 2.0 * taperT);
          float taperWidth = mix(1.0, 0.12, taperT);
          float ageScale = mix(1.55, 0.22, uStrikeAge01);
          float w = max(uWidth * taperWidth * ageScale, 1.0);

          vec2 offsetNdc = (normalPx * (w / uResolution)) * side;
          clipCurr.xy += offsetNdc * clipCurr.w;

          float windT = max(0.0, uStrikeAge01);
          vec2 windOffset = uWindDir * uTime * uWindDriftStrength * 0.08 * uvOffset * windT;
          clipCurr.xy += windOffset * clipCurr.w;

          gl_Position = clipCurr;
          vAlong = uvOffset;
          vTipFade = 1.0 - smoothstep(0.62, 1.0, uvOffset);
          vUv = vec2(uvOffset, side * 0.5 + 0.5);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uIntensity;
        uniform vec3 uOuterColor;
        uniform vec3 uCoreColor;
        uniform float uBrightness;
        uniform float uGlowStrength;
        uniform float uTextureScrollSpeed;
        uniform float uCoreStaticAmount;
        uniform float uCoreStaticRange;
        uniform float uGrowth;
        uniform float uStrikeAge01;
        uniform sampler2D uNoiseMap;

        varying vec2 vUv;
        varying float vAlong;
        varying float vTipFade;

        float saturate(float x) { return clamp(x, 0.0, 1.0); }

        void main() {
          float growthMask = 1.0 - smoothstep(uGrowth - 0.035, uGrowth + 0.008, vAlong);
          if (growthMask <= 0.001) discard;

          float y = abs(vUv.y - 0.5) * 2.0;
          float aa = max(fwidth(y), 0.0015);

          float outer = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, y);
          float core = 1.0 - smoothstep(0.55 - aa * 0.5, 0.55 + aa * 0.5, y);

          vec2 uvNoise = vec2(vUv.x * 2.5 + uTime * uTextureScrollSpeed, vUv.y * 1.25);
          float n = texture2D(uNoiseMap, uvNoise).r;

          float plasma = saturate(n * 1.25);
          float alpha = outer * (0.35 + 0.65 * plasma);
          alpha *= uIntensity;
          alpha *= vTipFade;
          alpha *= growthMask;
          alpha *= mix(0.45, 1.0, uGrowth);

          vec3 col = mix(uOuterColor, uCoreColor, core);
          vec3 hotColor = vec3(1.0, 1.0, 1.0);
          col = mix(col, hotColor, smoothstep(0.55, 1.0, uIntensity));
          col = mix(col, uOuterColor, smoothstep(0.35, 1.0, uStrikeAge01) * 0.85);
          vec3 rgb = col * (uBrightness * uGlowStrength);

          float staticRange = max(0.05, uCoreStaticRange);
          float coreZone = 1.0 - smoothstep(0.0, staticRange, vAlong);
          if (uCoreStaticAmount > 0.001 && coreZone > 0.001 && core > 0.001) {
            vec2 staticUvA = vec2(vAlong * 22.0 + uTime * 28.0, vUv.y * 10.0 + uTime * 19.0);
            vec2 staticUvB = vec2(vAlong * 31.0 - uTime * 21.0, vUv.y * 14.0 - uTime * 13.0);
            float staticA = texture2D(uNoiseMap, staticUvA).r;
            float staticB = texture2D(uNoiseMap, staticUvB).r;
            float crackle = saturate(staticA * staticB * 2.35);
            crackle = pow(crackle, 2.8) * coreZone * core;
            rgb *= 1.0 + crackle * uCoreStaticAmount * 1.65;
            alpha *= 1.0 + crackle * uCoreStaticAmount * 0.45;
          }

          gl_FragColor = vec4(rgb, alpha);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      // Strikes sit at map Z while tokens are higher; skip depth so renderOrder stacks above tokens.
      depthTest: false,
      blending: THREE.AdditiveBlending
    });

    material.toneMapped = false;

    return material;
  }

  _spawnStrike(source, timeInfo, isWild) {
    const strike = this._allocStrike();
    if (!strike) return;

    strike.active = true;
    strike.mesh.visible = true;

    strike.startTimeMs = timeInfo.elapsed * 1000;
    strike.durationMs = this.params.strikeDurationMs;

    strike.seed = this._randFloat(strike.rng);
    strike.baseIntensity = Math.max(0.05, source.intensity);
    strike.widthScale = 1.0;
    strike.isBranch = false;
    strike.parentStrike = null;
    strike.growthSpeed = 1.0;
    strike.returnStrokeTriggered = false;
    strike.restrikeCount = this._randInt(
      strike.rng,
      this.params.burstMinStrikes,
      this.params.burstMaxStrikes
    );
    const leaderBase = Math.max(0.1, this.params.leaderFraction);
    strike.leaderFrac = this._randFloatRange(
      strike.rng,
      Math.max(0.12, leaderBase - 0.05),
      Math.min(0.35, leaderBase + 0.05)
    );

    const start = this._tempVec3A;
    const end = this._tempVec3B;

    start.set(source.startX, source.startY, source.startZ);
    end.set(source.endX, source.endY, source.endZ);

    if (this.params.endPointRandomnessPx > 0.0) {
      end.x += this._randFloatRange(strike.rng, -this.params.endPointRandomnessPx, this.params.endPointRandomnessPx);
      end.y += this._randFloatRange(strike.rng, -this.params.endPointRandomnessPx, this.params.endPointRandomnessPx);
    }

    if (isWild) {
      const dx = this._randFloatRange(strike.rng, -1, 1);
      const dy = this._randFloatRange(strike.rng, -1, 1);
      const len = Math.max(1e-4, Math.sqrt(dx * dx + dy * dy));
      const dirX = dx / len;
      const dirY = dy / len;
      const dist = this._randFloatRange(strike.rng, 200, 900);
      end.x = start.x + dirX * dist;
      end.y = start.y + dirY * dist;
    }

    const mainDx = end.x - start.x;
    const mainDy = end.y - start.y;
    const mainLen = Math.max(1e-4, Math.sqrt(mainDx * mainDx + mainDy * mainDy));

    strike.flashStartX = start.x;
    strike.flashStartY = start.y;
    strike.flashStartZ = start.z;
    strike.flashEndX = end.x;
    strike.flashEndY = end.y;
    strike.flashEndZ = end.z;

    const perpX = -mainDy / mainLen;
    const perpY = mainDx / mainLen;
    const windSign = this._randFloat(strike.rng) < 0.5 ? -1.0 : 1.0;
    strike.windDirX = perpX * windSign + (mainDx / mainLen) * 0.12;
    strike.windDirY = perpY * windSign + (mainDy / mainLen) * 0.12;
    const windLen = Math.max(1e-4, Math.hypot(strike.windDirX, strike.windDirY));
    strike.windDirX /= windLen;
    strike.windDirY /= windLen;

    const seg = Math.max(4, Math.min(this._maxPointsPerStrike - 1, this.params.segments | 0));
    const pointCount = seg + 1;

    this._fillStrikeGeometry(strike, start, end, pointCount);

    if (this.params.branchMax > 0 && this._randFloat(strike.rng) < this.params.branchChance) {
      const positions = strike.arrays.positions;
      const maxBranches = Math.max(0, this.params.branchMax | 0);
      const branchCount = this._randInt(strike.rng, 1, Math.max(1, maxBranches));

      const startIdxMax = Math.max(2, pointCount - 2);
      for (let bi = 0; bi < branchCount; bi++) {
        const branch = this._allocStrike();
        if (!branch) break;

        branch.active = true;
        branch.mesh.visible = true;

        branch.startTimeMs = strike.startTimeMs;
        branch.durationMs = Math.max(20, this.params.strikeDurationMs * Math.max(0.1, this.params.branchDurationScale));

        branch.seed = this._randFloat(branch.rng);
        branch.baseIntensity = Math.max(0.01, strike.baseIntensity * Math.max(0.05, this.params.branchIntensityScale));
        branch.widthScale = Math.max(0.05, this.params.branchWidthScale);
        branch.isBranch = true;
        branch.parentStrike = strike;
        branch.growthSpeed = this._randFloatRange(strike.rng, 0.84, 0.96);
        branch.restrikeCount = strike.restrikeCount;
        branch.leaderFrac = strike.leaderFrac;
        branch.returnStrokeTriggered = false;
        branch.windDirX = strike.windDirX;
        branch.windDirY = strike.windDirY;
        branch.flashStartX = 0;
        branch.flashStartY = 0;
        branch.flashStartZ = 0;
        branch.flashEndX = 0;
        branch.flashEndY = 0;
        branch.flashEndZ = 0;

        const r = this._randFloat(strike.rng);
        const idx = 1 + Math.min(startIdxMax - 1, Math.floor(Math.pow(r, 1.7) * (startIdxMax - 1)));

        const v0 = idx * 2;
        const x0 = positions[v0 * 3 + 0];
        const y0 = positions[v0 * 3 + 1];
        const z0 = positions[v0 * 3 + 2];

        const vPrev = (idx - 1) * 2;
        const vNext = (idx + 1) * 2;
        let tx = positions[vNext * 3 + 0] - positions[vPrev * 3 + 0];
        let ty = positions[vNext * 3 + 1] - positions[vPrev * 3 + 1];
        const tlen = Math.max(1e-4, Math.sqrt(tx * tx + ty * ty));
        tx /= tlen;
        ty /= tlen;

        const sign = this._randFloat(strike.rng) < 0.5 ? -1.0 : 1.0;
        const angleDeg = Math.max(10.0, this.params.branchAngleDeg)
          + this._randFloatRange(strike.rng, -8.0, 8.0);
        const angleRad = angleDeg * sign * (Math.PI / 180.0);
        const cosR = Math.cos(angleRad);
        const sinR = Math.sin(angleRad);
        const bx = (tx * cosR) - (ty * sinR);
        const by = (tx * sinR) + (ty * cosR);

        const frac = this._randFloatRange(strike.rng, this.params.branchLengthMin, this.params.branchLengthMax);
        const branchLen = Math.max(10.0, mainLen * Math.max(0.05, frac));

        start.set(x0, y0, z0);
        end.set(
          x0 + bx * branchLen,
          y0 + by * branchLen,
          z0
        );

        const bSeg = Math.max(3, Math.min(this._maxPointsPerStrike - 1, Math.floor(seg * 0.5)));
        const bPointCount = bSeg + 1;
        const dispScale = Math.max(0.42, Math.min(1.0, branchLen / Math.max(1.0, mainLen)));
        this._fillStrikeGeometry(branch, start, end, bPointCount, dispScale);

        branch.material.uniforms.uTime.value = timeInfo.elapsed;
        branch.material.uniforms.uIntensity.value = 1.0;
      }
    }

    strike.material.uniforms.uTime.value = timeInfo.elapsed;
    strike.material.uniforms.uIntensity.value = 1.0;

    if (this.params.audioEnabled && this.params.audioStrikePath) {
      this._onStrikeAudio({
        sourceId: source.id,
        intensity: strike.baseIntensity,
        isWild
      });
    }
  }

  _allocStrike() {
    for (let i = 0; i < this._strikePool.length; i++) {
      const s = this._strikePool[i];
      if (!s.active) return s;
    }
    return null;
  }

  _deactivateStrike(strike) {
    if (!strike) return;
    strike.active = false;
    strike.mesh.visible = false;
    strike.geometry.setDrawRange(0, 0);
    strike.material.uniforms.uIntensity.value = 0.0;
    strike.material.uniforms.uGrowth.value = 0.0;
    strike.widthScale = 1.0;
    strike.isBranch = false;
    strike.parentStrike = null;
    strike.returnStrokeTriggered = false;
    this._disposeStrikeOriginFlash(strike);
  }

  _registerWallHooks() {
    if (this._hookIds.length > 0) return;

    const safeOn = (hook, fn) => {
      try {
        const id = Hooks.on(hook, fn);
        this._hookIds.push([hook, id]);
      } catch (_) {
      }
    };

    const onWallChanged = () => {
      this._needsOriginFlashWallRebuild = true;
    };

    safeOn('createWall', onWallChanged);
    safeOn('updateWall', onWallChanged);
    safeOn('deleteWall', onWallChanged);
  }

  /** @private */
  _buildOriginFlashWallClipOptions() {
    const allowWindows = this.params.originFlashAllowWindows !== false;
    const opts = {
      sense: 'light',
      blockGeometry: !allowWindows,
      wallPaddingPx: Math.max(0, Number(this.params.originFlashWallPaddingPx) || 0)
    };
    try {
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

  /** @private */
  _getSceneBoundsForWallClip() {
    const d = canvas?.dimensions;
    return {
      x: d?.sceneX ?? 0,
      y: d?.sceneY ?? 0,
      width: d?.sceneWidth ?? d?.width ?? 1,
      height: d?.sceneHeight ?? d?.height ?? 1
    };
  }

  /**
   * Wall-clipped polygon for origin flash LightMesh (world-space flat array).
   * @private
   */
  _computeOriginFlashWallPoints(worldX, worldY, radiusPx) {
    if (this.params.originFlashWallClipEnabled === false) return null;

    const clipRadius = Math.max(
      32,
      radiusPx * Math.max(0.1, Number(this.params.originFlashWallClipRadiusScale) || 1.0)
    );
    const foundryCenter = Coordinates.toFoundry(worldX, worldY);
    const walls = canvas?.walls?.placeables ?? [];

    let foundryPoly = null;
    try {
      foundryPoly = this._visionComputer.compute(
        { x: foundryCenter.x, y: foundryCenter.y },
        clipRadius,
        walls,
        this._getSceneBoundsForWallClip(),
        this._buildOriginFlashWallClipOptions()
      );
    } catch (_) {
      foundryPoly = null;
    }

    if (!foundryPoly || foundryPoly.length < 6) return null;

    const worldPoints = [];
    for (let i = 0; i < foundryPoly.length; i += 2) {
      const wp = Coordinates.toWorld(foundryPoly[i], foundryPoly[i + 1]);
      worldPoints.push(wp.x, wp.y);
    }
    return worldPoints;
  }

  /** Force wall polygons to rebuild on next origin-flash update. @private */
  _invalidateOriginFlashWallClip() {
    for (let i = 0; i < this._strikePool.length; i++) {
      const meshes = this._strikePool[i]?.originFlashMeshes;
      if (!meshes) continue;
      for (let j = 0; j < meshes.length; j++) {
        const entry = meshes[j];
        if (entry) entry.lastClipRadius = -1;
      }
    }
  }

  /**
   * Apply or refresh wall-clipped geometry on an origin flash LightMesh.
   * @private
   */
  _applyOriginFlashWallClip(lm, worldX, worldY, radiusPx, entry = null) {
    if (!lm) return;

    const clipRadius = Math.max(
      32,
      radiusPx * Math.max(0.1, Number(this.params.originFlashWallClipRadiusScale) || 1.0)
    );

    if (this.params.originFlashWallClipEnabled === false) {
      lm.updatePolygon(null);
      if (entry) {
        entry.lastClipRadius = clipRadius;
        entry.wallPoints = null;
      }
      return;
    }

    const prevRadius = entry?.lastClipRadius ?? -1;
    const force = prevRadius < 0 || Math.abs(prevRadius - clipRadius) > 2.0;
    if (!force && entry?.wallPoints?.length >= 6) {
      lm.updatePolygon(entry.wallPoints);
      return;
    }

    const worldPoints = this._computeOriginFlashWallPoints(worldX, worldY, radiusPx);
    if (entry) {
      entry.lastClipRadius = clipRadius;
      entry.wallPoints = worldPoints;
    }

    if (worldPoints?.length >= 6) {
      lm.updatePolygon(worldPoints);
    } else {
      lm.updatePolygon(null);
    }
  }

  _tryAttachOriginFlashGroup() {
    const lightScene = this._lightingEffect?.lightScene;
    if (!lightScene || !this._originFlashGroup) return;

    if (this._originFlashGroup.parent !== lightScene) {
      try { this._originFlashGroup.removeFromParent(); } catch (_) {}
      try { lightScene.add(this._originFlashGroup); } catch (_) {}
    }
  }

  _syncOriginFlashGroupVisibility() {
    if (!this._originFlashGroup) return;
    const show = this.enabled
      && this.params.enabled
      && this.params.originFlashEnabled !== false;
    this._originFlashGroup.visible = show;
  }

  _getOriginFlashAnchorTargets(strike) {
    const mode = Number(this.params.originFlashAnchor) || 0;
    const targets = [];
    if (mode === 1 || mode === 2) {
      targets.push({
        x: strike.flashEndX,
        y: strike.flashEndY,
        scale: mode === 2 ? 0.85 : 1.0
      });
    }
    if (mode === 0 || mode === 2) {
      targets.push({
        x: strike.flashStartX,
        y: strike.flashStartY,
        scale: 1.0
      });
    }
    return targets;
  }

  _computeOriginFlashBaseColor(intensityMul) {
    const hotMix = clamp01(Number(this.params.originFlashHotMix) || 0);
    const core = this.params.coreColor || { r: 1, g: 1, b: 1 };
    const outer = this.params.outerColor || core;
    const t = clamp01(intensityMul);
    const r = outer.r + (core.r - outer.r) * t;
    const g = outer.g + (core.g - outer.g) * t;
    const b = outer.b + (core.b - outer.b) * t;
    return {
      r: r + (1.0 - r) * hotMix * t,
      g: g + (1.0 - g) * hotMix * t,
      b: b + (1.0 - b) * hotMix * t
    };
  }

  _computeOriginFlashVisualMul(strike, strikeIntensity, envelope, timeInfo) {
    const leaderFrac = Math.max(0.08, strike.leaderFrac || this.params.leaderFraction);
    const t = envelope.age01;
    const precursor = Math.max(0, Number(this.params.originFlashLeaderPrecursor) || 0);
    let visual = Math.max(0, strikeIntensity) * Math.max(0, Number(this.params.originFlashStrikeScale) || 0);

    if (t < leaderFrac && envelope.growth < 0.999) {
      const leaderT = envelope.growth / Math.max(0.001, leaderFrac);
      visual = Math.max(visual * leaderT, precursor * leaderT);
    }

    visual *= Math.max(0, Number(this.params.originFlashIntensity) || 0);

    const flickAmt = clamp01(Number(this.params.originFlashFlickerAmount) || 0);
    if (flickAmt > 0) {
      const rate = Math.max(0, Number(this.params.originFlashFlickerRate) || 0);
      const w = 6.283185307179586 * rate;
      const flick = 0.5 + 0.5 * Math.sin((timeInfo.elapsed * w) + (strike.seed * 41.3));
      visual *= (1.0 - flickAmt) + (flickAmt * flick);
    }

    const minGain = Math.max(0, Number(this.params.originFlashMinGain) || 0);
    return Math.max(minGain, visual);
  }

  /**
   * HDR emission gain for origin flash (compose alpha → darkness punch), candle-style.
   * @param {number} visualMul
   * @returns {number}
   */
  _computeOriginFlashEmissionGain(visualMul) {
    const cancel = Math.max(0, Number(this.params.originFlashDarknessCancel) || 0);
    if (cancel <= 0) return 0;

    let lightMul = 1.0;
    if (this.params.originFlashFollowPointLightGain) {
      const li = Number(this._lightingEffect?.params?.lightIntensity);
      lightMul = Number.isFinite(li) ? Math.max(0.25, li) : 2.0;
    }

    const darkness = clamp01(LightingDirector.get().masterDarkness);
    const nightBoost = Math.max(1, Number(this.params.originFlashDarknessNightBoost) || 1);
    const nightMul = 1.0 + darkness * (nightBoost - 1.0);
    const vis = Math.max(0, Number(visualMul) || 0);
    return cancel * lightMul * nightMul * vis;
  }

  _ensureStrikeOriginFlashMesh(strike, slotIndex, worldX, worldY) {
    const THREE = window.THREE;
    if (!THREE) return null;

    if (!strike.originFlashMeshes) strike.originFlashMeshes = [];

    let entry = strike.originFlashMeshes[slotIndex];
    if (entry?.lightMesh) {
      entry.lightMesh.center.set(worldX, worldY);
      if (entry.lightMesh.mesh) {
        entry.lightMesh.mesh.position.x = worldX;
        entry.lightMesh.mesh.position.y = worldY;
      }
      return entry;
    }

    const radius = Math.max(16, Number(this.params.originFlashRadiusPx) || 520);
    const inner = radius * Math.max(0.05, Number(this.params.originFlashInnerRadiusScale) || 0.18);
    const color = this._computeOriginFlashBaseColor(1.0);
    const center = new THREE.Vector2(worldX, worldY);
    const worldPoints = this._computeOriginFlashWallPoints(worldX, worldY, radius);
    const lm = new LightMesh(center, radius, color, {
      innerRadiusPx: inner,
      worldPoints,
      attenuation: Math.max(0.05, Number(this.params.originFlashAttenuation) || 0.9)
    });

    if (lm?.mesh) {
      lm.mesh.renderOrder = 95;
      this._originFlashGroup.add(lm.mesh);
    }

    entry = {
      lightMesh: lm,
      slot: slotIndex,
      lastClipRadius: Math.max(
        32,
        radius * Math.max(0.1, Number(this.params.originFlashWallClipRadiusScale) || 1.0)
      ),
      wallPoints: worldPoints
    };
    strike.originFlashMeshes[slotIndex] = entry;
    return entry;
  }

  _updateStrikeOriginFlash(strike, strikeIntensity, envelope, timeInfo) {
    if (!this.params.originFlashEnabled) {
      this._disposeStrikeOriginFlash(strike);
      return;
    }

    this._tryAttachOriginFlashGroup();
    if (!this._originFlashGroup?.parent) return;

    const targets = this._getOriginFlashAnchorTargets(strike);
    if (!targets.length) {
      this._disposeStrikeOriginFlash(strike);
      return;
    }

    const visualMul = this._computeOriginFlashVisualMul(strike, strikeIntensity, envelope, timeInfo);
    const radiusStrikeScale = Math.max(0, Number(this.params.originFlashRadiusStrikeScale) || 0);
    const radiusMul = 0.5 + Math.min(1.75, strikeIntensity * radiusStrikeScale);
    const radius = Math.max(16, Number(this.params.originFlashRadiusPx) * radiusMul);
    const inner = radius * Math.max(0.05, Number(this.params.originFlashInnerRadiusScale) || 0.18);
    const color = this._computeOriginFlashBaseColor(Math.min(1.25, visualMul));

    if (!strike.originFlashMeshes) strike.originFlashMeshes = [];

    for (let i = targets.length; i < strike.originFlashMeshes.length; i++) {
      this._disposeStrikeOriginFlashSlot(strike, i);
    }
    strike.originFlashMeshes.length = targets.length;

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const entry = this._ensureStrikeOriginFlashMesh(strike, i, target.x, target.y);
      const lm = entry?.lightMesh;
      if (!lm) continue;

      const slotVisual = visualMul * Math.max(0.05, target.scale || 1.0);
      const slotGain = this._computeOriginFlashEmissionGain(slotVisual);
      const slotRadius = radius * Math.max(0.35, Math.sqrt(target.scale || 1.0));

      lm.attenuation = Math.max(0.05, Number(this.params.originFlashAttenuation) || 0.9);
      this._applyOriginFlashWallClip(lm, target.x, target.y, slotRadius, entry);
      lm.updateAppearance(color, slotRadius, inner * Math.max(0.35, target.scale || 1.0));
      this._tempFlashColor.setRGB(color.r, color.g, color.b).multiplyScalar(slotVisual);
      lm.material.uniforms.uColor.value.copy(this._tempFlashColor);
      lm.setEmissionGain(slotGain);

      if (lm.mesh) {
        lm.mesh.visible = slotGain > 0.001;
      }
    }
  }

  _disposeStrikeOriginFlashSlot(strike, slotIndex) {
    const entry = strike?.originFlashMeshes?.[slotIndex];
    if (!entry) return;
    try {
      if (entry.lightMesh?.mesh) {
        this._originFlashGroup?.remove(entry.lightMesh.mesh);
      }
      entry.lightMesh?.dispose?.();
    } catch (_) {}
    strike.originFlashMeshes[slotIndex] = null;
  }

  _disposeStrikeOriginFlash(strike) {
    if (!strike?.originFlashMeshes?.length) {
      strike.originFlashMeshes = null;
      return;
    }
    for (let i = 0; i < strike.originFlashMeshes.length; i++) {
      this._disposeStrikeOriginFlashSlot(strike, i);
    }
    strike.originFlashMeshes = null;
  }

  _clearAllOriginFlashes() {
    for (let i = 0; i < this._strikePool.length; i++) {
      this._disposeStrikeOriginFlash(this._strikePool[i]);
    }
  }

  /**
   * Leader growth, return-stroke spike, and restrike decay envelope.
   * @private
   */
  _computeStrikeEnvelope(strike, t, timeInfo) {
    const leaderFrac = Math.max(0.08, strike.leaderFrac || this.params.leaderFraction);
    let growth = 0.0;

    if (strike.isBranch && strike.parentStrike?.active) {
      const parentT = (timeInfo.elapsed * 1000 - strike.parentStrike.startTimeMs)
        / Math.max(1, strike.parentStrike.durationMs);
      const parentLeader = Math.max(0.08, strike.parentStrike.leaderFrac || this.params.leaderFraction);
      const parentGrowthRaw = Math.min(1.0, parentT / parentLeader);
      const parentGrowth = parentGrowthRaw * parentGrowthRaw * (3.0 - 2.0 * parentGrowthRaw);
      if (parentGrowth >= 1.0) {
        growth = Math.min(1.0, strike.growthSpeed);
      } else {
        growth = Math.min(parentGrowth * strike.growthSpeed, parentGrowth);
      }
    } else {
      const leaderT = Math.min(1.0, t / leaderFrac);
      growth = leaderT * leaderT * (3.0 - 2.0 * leaderT);
    }

    const age01 = t;
    let env = 0.0;
    let triggerReturnFlash = false;

    const motionDelta = (typeof timeInfo?.motionDelta === 'number')
      ? timeInfo.motionDelta
      : (typeof timeInfo?.delta === 'number' ? timeInfo.delta : 0.016);

    if (t < leaderFrac) {
      const leaderProgress = t / leaderFrac;
      env = 0.05 + (0.16 * leaderProgress);
      if (this._randFloat(strike.rng) < this.params.flickerChance * motionDelta * 80.0) {
        env *= this._randFloatRange(strike.rng, 0.2, 0.85);
      }
    } else {
      const postT = (t - leaderFrac) / Math.max(0.001, 1.0 - leaderFrac);
      const restrikes = Math.max(0.0, Math.sin(postT * strike.restrikeCount * Math.PI));
      const decay = Math.pow(Math.max(0.0, 1.0 - postT), 2.0);
      const connectSpike = Math.exp(-postT * 28.0) * 1.75;
      env = Math.max(restrikes * decay, connectSpike);
      env = Math.max(env, decay * 0.1);

      if (!strike.returnStrokeTriggered && growth >= 0.995) {
        triggerReturnFlash = true;
      }

      if (this._randFloat(strike.rng) < this.params.flickerChance * motionDelta * 35.0) {
        env *= this._randFloatRange(strike.rng, 0.75, 1.0);
      }
    }

    return { env, growth, age01, triggerReturnFlash };
  }

  /**
   * Recursive midpoint displacement for fractal bolt paths.
   * @private
   */
  _buildFractalPath(x0, y0, x1, y1, rng, displacement, depth, outX, outY) {
    if (depth <= 0) {
      outX.push(x0);
      outY.push(y0);
      return;
    }

    const mx = (x0 + x1) * 0.5;
    const my = (y0 + y1) * 0.5;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.max(1e-4, Math.hypot(dx, dy));
    const nx = -dy / len;
    const ny = dx / len;
    const disp = this._randFloatRange(rng, -1.0, 1.0) * displacement;
    const cmx = mx + nx * disp;
    const cmy = my + ny * disp;
    const nextDisp = displacement * 0.58;

    this._buildFractalPath(x0, y0, cmx, cmy, rng, nextDisp, depth - 1, outX, outY);
    this._buildFractalPath(cmx, cmy, x1, y1, rng, nextDisp, depth - 1, outX, outY);
  }

  /**
   * Resample a polyline to an exact point count by arc length.
   * @private
   */
  _resamplePath(pathX, pathY, pointCount) {
    if (pathX.length < 2 || pointCount < 2) {
      return { xs: pathX.slice(), ys: pathY.slice() };
    }

    const segCount = pathX.length - 1;
    const segLens = new Float32Array(segCount);
    let totalLen = 0.0;
    for (let i = 0; i < segCount; i++) {
      const dx = pathX[i + 1] - pathX[i];
      const dy = pathY[i + 1] - pathY[i];
      const len = Math.hypot(dx, dy);
      segLens[i] = len;
      totalLen += len;
    }

    if (totalLen <= 1e-4) {
      const xs = new Array(pointCount);
      const ys = new Array(pointCount);
      for (let i = 0; i < pointCount; i++) {
        xs[i] = pathX[0];
        ys[i] = pathY[0];
      }
      return { xs, ys };
    }

    const xs = new Array(pointCount);
    const ys = new Array(pointCount);
    let segIdx = 0;
    let segStart = 0.0;

    for (let p = 0; p < pointCount; p++) {
      const target = (p / (pointCount - 1)) * totalLen;
      while (segIdx < segCount - 1 && (segStart + segLens[segIdx]) < target) {
        segStart += segLens[segIdx];
        segIdx++;
      }

      const segLen = Math.max(1e-6, segLens[segIdx]);
      const localT = Math.max(0.0, Math.min(1.0, (target - segStart) / segLen));
      xs[p] = pathX[segIdx] + (pathX[segIdx + 1] - pathX[segIdx]) * localT;
      ys[p] = pathY[segIdx] + (pathY[segIdx + 1] - pathY[segIdx]) * localT;
    }

    return { xs, ys };
  }

  _fillStrikeGeometry(strike, start, end, pointCount, displacementScale = 1.0) {
    const a = strike.arrays;
    const positions = a.positions;
    const prevPos = a.prevPos;
    const nextPos = a.nextPos;
    const uvOffset = a.uvOffset;

    const dirX = end.x - start.x;
    const dirY = end.y - start.y;
    const dirLen = Math.max(1e-4, Math.hypot(dirX, dirY));
    const nX = -dirY / dirLen;
    const nY = dirX / dirLen;

    const s = Math.max(0.0, displacementScale);
    const macroNorm = Math.max(0.0, Number(this.params.macroDisplacement) || 0) / 400.0;
    const curveBias = Math.max(0.0, Math.min(1.0, this.params.curveAmount));
    const arcSign = this._randFloat(strike.rng) < 0.5 ? -1.0 : 1.0;
    const bow = curveBias * (0.2 + macroNorm * 0.22);
    const midX = (start.x + end.x) * 0.5 + nX * dirLen * bow * arcSign;
    const midY = (start.y + end.y) * 0.5 + nY * dirLen * bow * arcSign;

    const chaos = 0.22 + curveBias * 0.9;
    const baseDisp = dirLen * Math.max(0.055, macroNorm * chaos) * s;
    const depth = Math.max(1, Math.round(Math.log2(Math.max(2, pointCount - 1))));

    const rawX = [];
    const rawY = [];
    this._buildFractalPath(start.x, start.y, midX, midY, strike.rng, baseDisp, depth, rawX, rawY);
    this._buildFractalPath(midX, midY, end.x, end.y, strike.rng, baseDisp * 0.85, depth, rawX, rawY);
    rawX.push(end.x);
    rawY.push(end.y);

    const resampled = this._resamplePath(rawX, rawY, pointCount);
    const microNorm = Math.max(0.0, Number(this.params.microJitter) || 0) / 120.0;
    const micro = dirLen * Math.max(0.004, microNorm * 0.035) * s;

    for (let i = 0; i < pointCount; i++) {
      const t = pointCount <= 1 ? 0 : i / (pointCount - 1);
      const tipEase = t * t * (3.0 - 2.0 * t);
      const jitterFalloff = 1.0 - tipEase;
      const dMicro = this._randFloatRange(strike.rng, -1.0, 1.0) * micro * jitterFalloff;

      const px = resampled.xs[i] + nX * dMicro;
      const py = resampled.ys[i] + nY * dMicro;
      const pz = start.z;

      const v0 = i * 2;
      const v1 = v0 + 1;

      uvOffset[v0] = t;
      uvOffset[v1] = t;

      positions[(v0 * 3) + 0] = px;
      positions[(v0 * 3) + 1] = py;
      positions[(v0 * 3) + 2] = pz;

      positions[(v1 * 3) + 0] = px;
      positions[(v1 * 3) + 1] = py;
      positions[(v1 * 3) + 2] = pz;
    }

    for (let i = 0; i < pointCount; i++) {
      const iPrev = Math.max(0, i - 1);
      const iNext = Math.min(pointCount - 1, i + 1);

      const pPrev = iPrev * 2;
      const pCurr = i * 2;
      const pNext = iNext * 2;

      const prevX = positions[pPrev * 3 + 0];
      const prevY = positions[pPrev * 3 + 1];
      const prevZ = positions[pPrev * 3 + 2];

      const nextX = positions[pNext * 3 + 0];
      const nextY = positions[pNext * 3 + 1];
      const nextZ = positions[pNext * 3 + 2];

      for (let k = 0; k < 2; k++) {
        const v = pCurr + k;
        prevPos[v * 3 + 0] = prevX;
        prevPos[v * 3 + 1] = prevY;
        prevPos[v * 3 + 2] = prevZ;

        nextPos[v * 3 + 0] = nextX;
        nextPos[v * 3 + 1] = nextY;
        nextPos[v * 3 + 2] = nextZ;
      }
    }

    const geom = strike.geometry;
    geom.attributes.position.needsUpdate = true;
    geom.attributes.prevPos.needsUpdate = true;
    geom.attributes.nextPos.needsUpdate = true;
    geom.attributes.uvOffset.needsUpdate = true;

    if (pointCount > 1) {
      geom.setDrawRange(0, (pointCount - 1) * 6);
    } else {
      geom.setDrawRange(0, 0);
    }

    strike.pointCount = pointCount;
  }

  _onStrikeAudio(_info) {
  }

  _createNoiseTexture() {
    const THREE = window.THREE;
    const size = 128;

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    const img = ctx.createImageData(size, size);
    const d = img.data;

    let seed = 1337;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967295;
    };

    for (let i = 0; i < size * size; i++) {
      const r = rand();
      const v = Math.floor(r * 255);
      const o = i * 4;
      d[o] = v;
      d[o + 1] = v;
      d[o + 2] = v;
      d[o + 3] = 255;
    }

    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;

    return tex;
  }

  _hashStringToUint(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  _randFloat(rng) {
    rng.state = (Math.imul(rng.state, 1664525) + 1013904223) >>> 0;
    return rng.state / 4294967295;
  }

  _randFloatRange(rng, a, b) {
    return a + (b - a) * this._randFloat(rng);
  }

  _randInt(rng, a, b) {
    const lo = Math.min(a, b) | 0;
    const hi = Math.max(a, b) | 0;
    return lo + Math.floor(this._randFloat(rng) * (hi - lo + 1));
  }
}
