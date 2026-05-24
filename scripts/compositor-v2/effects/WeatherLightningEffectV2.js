/**
 * @fileoverview WeatherLightningEffectV2 — distant landscape lightning flashes.
 *
 * Simulates illumination from nearby strikes: pre-baked compass-directional
 * shadows, outdoor ambient flash, and window-light boost. No bolt geometry.
 *
 * @module compositor-v2/effects/WeatherLightningEffectV2
 */

import { createLogger } from '../../core/log.js';
import { LightingDirector } from '../../core/LightingDirector.js';
import {
  getClockwiseHourDelta,
  getFoundryTimePhaseHours,
  getWrappedHourProgress,
} from '../../core/foundry-time-phases.js';
import { resolveEffectEnabled } from '../../effects/resolve-effect-enabled.js';
import { LightningShadowBakeCache, DEFAULT_LIGHTNING_ELEVATION_DEG } from '../lightning/LightningShadowBakeCache.js';
import { LightningStrikeShadowSnapshot } from '../lightning/LightningStrikeShadowSnapshot.js';

const log = createLogger('WeatherLightningEffectV2');

const clamp01 = (v, fb = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fb;
};

/** @param {number} seed */
const flickerHash01 = (seed) => {
  const s = Math.sin(seed * 127.1 + seed * 311.7) * 43758.5453123;
  return s - Math.floor(s);
};

/** @param {number} t */
const smoothstep01 = (t) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};

export class WeatherLightningEffectV2 {
  constructor() {
    this.id = 'weather-lightning';
    this.layer = { order: 395, name: 'Environmental', requiresDepth: false };
    this.floorScope = 'global';
    this.enabled = true;
    this.isInitialized = false;

    this.params = WeatherLightningEffectV2.createDefaultParams();

    this._initialized = false;
    this._floorCompositor = null;
    this._bakeCache = new LightningShadowBakeCache();
    this._strikeSnapshot = new LightningStrikeShadowSnapshot();
    /** @type {object[]} Overlapping strike envelopes (see _createStrikeRecord). */
    this._activeStrikes = [];
    /** Azimuth captured into {@link LightningStrikeShadowSnapshot} (re-capture when dominant drifts). */
    this._snapshotAzimuthDeg = Number.NaN;
    this._flashStartMs = -1;
    this._flashPeak = 0.0;
    this._flashValue = 0.0;
    this._activeAzimuthDeg = 180;
    this._strikeShadowWeight = 0.85;
    this._nextAutoStrikeMs = 0;
    this._seriesQueue = [];
    this._envFlash01 = 0;
    this._envShadowFlash01 = 0;
    /** True while any GM manual strike plays at full config brightness (live slider at 0). */
    this._manualStrikeBoost = false;
  }

  /**
   * Canonical default parameter object (constructor + schema + reset).
   * @returns {object}
   */
  static createDefaultParams() {
    return {
      enabled: true,
      stormIntensity: 0,
      flashBrightness: 0.64,
      flashFrequency: 0.51,
      distanceVariation: 0.8,
      shadowLengthScale: 2.0,
      shadowSmearScale: 2.0,
      lightningShadowFlashFloor: 0,
      lightningShadowFlashGamma: 0.72,
      lightningFlashContrast: 3,
      lightningShadowDarkness: 4,
      windowFlashBoost: 3,
      windowFlashPeakMultiplier: 20,
      outdoorFlashStrength: 1,
      /** Flash strength at bright noon. */
      dayFlashBrightnessScale: 0.2,
      /** Flash strength at dawn phase (morning twilight). */
      dawnFlashBrightnessScale: 0.28,
      /** Flash strength at dusk phase (evening twilight). */
      duskFlashBrightnessScale: 0.28,
      /** Flash strength near midnight. */
      nightFlashBrightnessScale: 1.26,
      /** Hour radius around dawn/dusk/noon anchors (wider = more twilight coverage). */
      twilightFlashBlendHours: 2.5,
      /** Sharpness of night-arc ramp (midnight peak vs sunset/sunrise). */
      dayNightFlashCurve: 2.9,
      /** Cold lightning flash tint (linear RGB). */
      lightningFlashColorR: 0.43,
      lightningFlashColorG: 0.5,
      lightningFlashColorB: 0.67,
      shadowBlendWeight: 0.98,
      shadowFadeDurationScale: 3.5,
      shadowFadeCurve: 2.0,
      flashAttackMs: 0,
      flashFlickerHoldMs: 1400,
      flashDecayMs: 3850,
      flashDecayCurve: 1.31,
      flashFlickerAmount: 0.17,
      flashFlickerRate: 40,
      flashMaxClamp: 0,
      brightnessMin: 0.68,
      brightnessMax: 1.0,
      minDelayMs: 500,
      maxDelayMs: 1000,
      smallStrikeDecayMs: 2400,
      bigStrikeDecayMs: 4500,
    };
  }

  static getControlSchema() {
    const d = WeatherLightningEffectV2.createDefaultParams();
    return {
      enabled: true,
      groups: [
        {
          name: 'storm',
          label: 'Storm',
          type: 'inline',
          parameters: [
            'stormIntensity', 'flashBrightness', 'flashFrequency', 'distanceVariation',
            'shadowLengthScale', 'shadowSmearScale', 'windowFlashBoost', 'windowFlashPeakMultiplier',
            'outdoorFlashStrength',
            'dayFlashBrightnessScale', 'dawnFlashBrightnessScale', 'duskFlashBrightnessScale',
            'nightFlashBrightnessScale', 'twilightFlashBlendHours', 'dayNightFlashCurve',
            'shadowBlendWeight', 'shadowFadeDurationScale', 'shadowFadeCurve',
            'lightningShadowFlashFloor', 'lightningFlashContrast', 'lightningShadowDarkness',
            'lightningFlashColorR', 'lightningFlashColorG', 'lightningFlashColorB',
          ],
        },
        {
          name: 'envelope',
          label: 'Flash Envelope',
          type: 'inline',
          advanced: true,
          parameters: [
            'flashAttackMs', 'flashFlickerHoldMs', 'flashDecayMs', 'flashDecayCurve',
            'flashFlickerAmount', 'flashFlickerRate', 'flashMaxClamp',
            'brightnessMin', 'brightnessMax', 'minDelayMs', 'maxDelayMs',
          ],
        },
        {
          name: 'gm',
          label: 'GM Triggers',
          type: 'inline',
          advanced: true,
          parameters: ['triggerSmallStrike', 'triggerBigStrike', 'triggerStrikeSeries'],
        },
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },
        stormIntensity: {
          type: 'slider', min: 0, max: 1, step: 0.01, default: d.stormIntensity,
          label: 'Storm Intensity',
          tooltip: 'Automatic distant lightning activity when > 0.',
        },
        flashBrightness: {
          type: 'slider', min: 0, max: 1, step: 0.01, default: d.flashBrightness,
          label: 'Flash Brightness',
        },
        flashFrequency: {
          type: 'slider', min: 0, max: 1, step: 0.01, default: d.flashFrequency,
          label: 'Flash Frequency',
        },
        distanceVariation: {
          type: 'slider', min: 0, max: 1, step: 0.01, default: d.distanceVariation,
          label: 'Distance Variation',
          tooltip: 'Spread between dimmer distant strikes and bright near strikes.',
        },
        shadowLengthScale: {
          type: 'slider', min: 0.5, max: 8, step: 0.1, default: d.shadowLengthScale,
          label: 'Shadow Length Scale',
          tooltip: 'Multiplier on building shadow ray length during a strike (2–3 recommended).',
        },
        shadowSmearScale: {
          type: 'slider', min: 0.25, max: 2, step: 0.05, default: d.shadowSmearScale,
          label: 'Shadow Smear Mul',
          tooltip: 'Scales BuildingShadowsEffectV2 smear/softness (1 = same as building pass).',
        },
        windowFlashBoost: {
          type: 'slider', min: 0, max: 3, step: 0.05, default: d.windowFlashBoost,
          label: 'Window Flash Boost',
          tooltip: 'Legacy scale; peak multiplier below drives visible window punch.',
        },
        windowFlashPeakMultiplier: {
          type: 'slider', min: 1, max: 20, step: 0.5, default: d.windowFlashPeakMultiplier,
          label: 'Window Peak Multiplier',
          tooltip: 'At full flash, window intensity ≈ this many× normal (9 ≈ 10×).',
        },
        outdoorFlashStrength: {
          type: 'slider', min: 0, max: 24, step: 0.1, default: d.outdoorFlashStrength,
          label: 'Outdoor Flash Strength',
        },
        dayFlashBrightnessScale: {
          type: 'slider', min: 0, max: 1, step: 0.01, default: d.dayFlashBrightnessScale,
          label: 'Day Flash Scale',
          tooltip: 'Lightning brightness at solar noon.',
        },
        dawnFlashBrightnessScale: {
          type: 'slider', min: 0, max: 1, step: 0.01, default: d.dawnFlashBrightnessScale,
          label: 'Dawn Flash Scale',
          tooltip: 'Lightning brightness around the dawn phase (morning twilight).',
        },
        duskFlashBrightnessScale: {
          type: 'slider', min: 0, max: 1, step: 0.01, default: d.duskFlashBrightnessScale,
          label: 'Dusk Flash Scale',
          tooltip: 'Lightning brightness around the dusk phase (evening twilight).',
        },
        nightFlashBrightnessScale: {
          type: 'slider', min: 0, max: 2, step: 0.01, default: d.nightFlashBrightnessScale,
          label: 'Night Flash Scale',
          tooltip: 'Lightning brightness near midnight.',
        },
        twilightFlashBlendHours: {
          type: 'slider', min: 0.5, max: 6, step: 0.1, default: d.twilightFlashBlendHours,
          label: 'Twilight Blend (h)',
          tooltip: 'How many hours dawn/dusk scales stay influential around their phase anchors.',
        },
        dayNightFlashCurve: {
          type: 'slider', min: 0.2, max: 4, step: 0.05, default: d.dayNightFlashCurve,
          label: 'Night Ramp Curve',
          tooltip: 'How sharply flash strength rises from twilight toward midnight.',
        },
        shadowBlendWeight: {
          type: 'slider', min: 0, max: 1, step: 0.01, default: d.shadowBlendWeight,
          label: 'Shadow Blend Weight',
        },
        shadowFadeDurationScale: {
          type: 'slider', min: 1, max: 6, step: 0.05, default: d.shadowFadeDurationScale,
          label: 'Shadow Fade Length',
          tooltip: 'How much longer lightning shadows linger vs the light flash.',
        },
        shadowFadeCurve: {
          type: 'slider', min: 0.2, max: 2, step: 0.02, default: d.shadowFadeCurve,
          label: 'Shadow Fade Softness',
          tooltip: 'Lower = gentler shadow release at end of strike.',
        },
        lightningShadowFlashFloor: {
          type: 'slider', min: 0, max: 0.5, step: 0.01, default: d.lightningShadowFlashFloor,
          label: 'Shadow Flash Floor',
          tooltip: 'Minimum flash in deep shadow (lower = darker umbra during strike).',
        },
        lightningFlashContrast: {
          type: 'slider', min: 0, max: 3, step: 0.05, default: d.lightningFlashContrast,
          label: 'Flash Contrast',
        },
        lightningShadowDarkness: {
          type: 'slider', min: 1, max: 4, step: 0.05, default: d.lightningShadowDarkness,
          label: 'Shadow Darkness',
          tooltip: 'Power curve on lightning shadow depth (>1 = darker).',
        },
        lightningFlashColorR: {
          type: 'slider', min: 0, max: 2, step: 0.01, default: d.lightningFlashColorR,
          label: 'Flash Color R',
        },
        lightningFlashColorG: {
          type: 'slider', min: 0, max: 2, step: 0.01, default: d.lightningFlashColorG,
          label: 'Flash Color G',
        },
        lightningFlashColorB: {
          type: 'slider', min: 0, max: 2, step: 0.01, default: d.lightningFlashColorB,
          label: 'Flash Color B',
          tooltip: 'Cold lightning defaults ~0.43 / 0.50 / 0.67.',
        },
        flashAttackMs: { type: 'slider', min: 0, max: 80, step: 1, default: d.flashAttackMs, label: 'Attack (ms)' },
        flashFlickerHoldMs: {
          type: 'slider', min: 0, max: 4000, step: 50, default: d.flashFlickerHoldMs,
          label: 'Flicker Hold (ms)',
          tooltip: 'Peak brightness with flicker before the slow fade.',
        },
        flashDecayMs: { type: 'slider', min: 200, max: 8000, step: 50, default: d.flashDecayMs, label: 'Fade Out (ms)' },
        flashDecayCurve: { type: 'slider', min: 0.25, max: 4, step: 0.01, default: d.flashDecayCurve, label: 'Fade Curve' },
        flashFlickerAmount: {
          type: 'slider', min: 0, max: 1, step: 0.01, default: d.flashFlickerAmount,
          label: 'Flicker Amount',
          tooltip: 'How deep dips and surges modulate the peak hold.',
        },
        flashFlickerRate: {
          type: 'slider', min: 0, max: 40, step: 0.1, default: d.flashFlickerRate,
          label: 'Flicker Chaos',
          tooltip: 'Irregular pulse density during hold (higher = busier, more micro-variation).',
        },
        flashMaxClamp: { type: 'slider', min: 0, max: 10, step: 0.05, default: d.flashMaxClamp, label: 'Flash Clamp' },
        brightnessMin: { type: 'slider', min: 0, max: 1, step: 0.01, default: d.brightnessMin, label: 'Brightness Min' },
        brightnessMax: { type: 'slider', min: 0, max: 1, step: 0.01, default: d.brightnessMax, label: 'Brightness Max' },
        minDelayMs: { type: 'slider', min: 500, max: 60000, step: 500, default: d.minDelayMs, label: 'Min Delay (ms)' },
        maxDelayMs: { type: 'slider', min: 1000, max: 120000, step: 500, default: d.maxDelayMs, label: 'Max Delay (ms)' },
        smallStrikeDecayMs: { type: 'slider', min: 200, max: 6000, step: 50, default: d.smallStrikeDecayMs, label: 'Small Strike Fade (ms)', hidden: true },
        bigStrikeDecayMs: { type: 'slider', min: 500, max: 12000, step: 50, default: d.bigStrikeDecayMs, label: 'Big Strike Fade (ms)', hidden: true },
        triggerSmallStrike: {
          type: 'button', title: 'Small Strike', label: 'Small Strike', gmOnly: true,
        },
        triggerBigStrike: {
          type: 'button', title: 'Big Strike', label: 'Big Strike', gmOnly: true,
        },
        triggerStrikeSeries: {
          type: 'button', title: '30s Series', label: '30s Series', gmOnly: true,
        },
      },
    };
  }

  applyParamChange(paramId, value) {
    if (paramId === 'enabled') {
      this.enabled = !!value;
      this.params.enabled = !!value;
      return;
    }
    if (paramId === 'triggerSmallStrike') {
      this.triggerSmallStrike();
      return;
    }
    if (paramId === 'triggerBigStrike') {
      this.triggerBigStrike();
      return;
    }
    if (paramId === 'triggerStrikeSeries') {
      this.triggerStrikeSeries(30000);
      return;
    }
    if (this.params && Object.prototype.hasOwnProperty.call(this.params, paramId)) {
      this.params[paramId] = value;
    }
    if (
      paramId === 'shadowLengthScale' ||
      paramId === 'shadowSmearScale' ||
      paramId === 'stormIntensity'
    ) {
      this._bakeCache.invalidate('param-change');
    }
  }

  setFloorCompositor(fc) {
    this._floorCompositor = fc ?? null;
  }

  initialize() {
    this._initialized = true;
    this.isInitialized = true;
    log.info('WeatherLightningEffectV2 initialized');
  }

  invalidateCache(reason = '') {
    this._bakeCache.invalidate(reason);
  }

  getBakeStatusLabel() {
    return this._bakeCache.getStatusLabel();
  }

  /**
   * Live GM intensity scale (0 = off, 1 = full config brightness + frequency).
   * @returns {number}
   */
  _getLiveIntensityScale() {
    return clamp01(this.params.stormIntensity, 0);
  }

  /**
   * Brightness scale for an active or pending strike.
   * Manual GM triggers still flash at full config when the live slider is at zero.
   * @param {'small'|'big'|'auto'} [kind]
   * @returns {number}
   */
  _getEffectiveIntensityScale(kind = 'auto') {
    const live = this._getLiveIntensityScale();
    if (this._manualStrikeBoost || (kind !== 'auto' && live <= 0.001)) return 1.0;
    return live;
  }

  /**
   * @param {number} [hourMs]
   * @returns {{ min: number, max: number }}
   */
  _resolveDelayRange() {
    const freq = clamp01(this.params.flashFrequency, 0.35) * this._getLiveIntensityScale();
    const minBase = Math.max(500, Number(this.params.minDelayMs) || 8000);
    const maxBase = Math.max(minBase + 500, Number(this.params.maxDelayMs) || 28000);
    const min = minBase + (1 - freq) * (maxBase - minBase) * 0.85;
    const max = min + (maxBase - min) * (0.35 + freq * 0.65);
    return { min, max };
  }

  /**
   * Relative peak brightness for a strike kind (0..1 of configured max).
   * Small strikes are a faint fraction of a full strike — typically 10–32%.
   * @param {'small'|'big'|'auto'} [kind]
   * @returns {number}
   */
  _pickStrikePeakFraction(kind = 'auto') {
    if (kind === 'small') return 0.10 + Math.random() * 0.22;
    if (kind === 'big') return 0.88 + Math.random() * 0.12;
    const roll = Math.random();
    if (roll < 0.14) return 0.88 + Math.random() * 0.12;
    if (roll < 0.62) return 0.10 + Math.random() * 0.22;
    const spread = clamp01(this.params.distanceVariation, 0.5);
    return 0.35 + spread * (0.25 + Math.random() * 0.4);
  }

  /**
   * Absolute strike brightness before flashBrightness scaling.
   * Small uses a fraction of max — NOT interpolated from brightnessMin (that kept small ~75% as bright as big).
   * @param {'small'|'big'|'auto'} [kind]
   * @returns {number}
   */
  _pickStrikeBrightness(kind = 'auto') {
    const vmin = clamp01(this.params.brightnessMin, 0.22);
    const vmax = clamp01(this.params.brightnessMax, 1);
    const frac = this._pickStrikePeakFraction(kind);
    if (kind === 'small') {
      return vmax * frac;
    }
    if (kind === 'big') {
      return vmax * Math.max(frac, 0.92);
    }
    if (frac < 0.55) {
      return vmax * frac;
    }
    const spread = clamp01(this.params.distanceVariation, 0.5);
    return vmin + (vmax - vmin) * spread * (0.35 + (frac - 0.55) * 0.9);
  }

  /**
   * @param {'small'|'big'|'auto'} kind
   * @returns {object}
   * @private
   */
  _createStrikeRecord(kind = 'auto') {
    const flashSeed = Math.random();
    const baseHoldMs = Math.max(0, Number(this.params.flashFlickerHoldMs) || 550);
    const flickerHoldMs = kind === 'small'
      ? Math.max(60, baseHoldMs * 0.22)
      : baseHoldMs;
    const chaos = Math.max(0.5, Number(this.params.flashFlickerRate) || 10);
    const flickerProfile = flickerHoldMs > 0
      ? this._buildOrganicFlickerProfile(flashSeed, kind, chaos)
      : null;
    const blendW = clamp01(this.params.shadowBlendWeight, 0.98);
    const manualBoost = kind !== 'auto' && this._getLiveIntensityScale() <= 0.001;
    const scale = this._getEffectiveIntensityScale(kind);
    const bright = clamp01(this.params.flashBrightness, 0.7) * scale;
    let peak = this._pickStrikeBrightness(kind) * bright;
    if (kind === 'big') {
      peak = Math.max(peak, bright * 0.92);
    }
    let decayMs = Number(this.params.flashDecayMs) || 1950;
    if (kind === 'small') {
      decayMs = Math.min(
        Number(this.params.smallStrikeDecayMs) || 380,
        Math.max(120, decayMs * 0.35),
      );
    } else if (kind === 'big') {
      decayMs = Number(this.params.bigStrikeDecayMs) || 900;
    }
    return {
      kind,
      startMs: performance.now(),
      peak: Math.max(0, peak),
      azimuthDeg: Math.random() * 360,
      strikeShadowWeight: kind === 'small' ? blendW * 0.42 : blendW,
      flickerHoldMs,
      flickerProfile,
      decayMs,
      flashSeed,
      manualBoost,
    };
  }

  /**
   * @returns {boolean}
   * @private
   */
  _hasActiveStrikes() {
    return this._activeStrikes.length > 0;
  }

  /**
   * Smoothly combine overlapping flash contributions (additive screen blend, capped).
   * @param {number} base
   * @param {number} add
   * @returns {number}
   * @private
   */
  _blendFlashContribution(base, add) {
    const a = clamp01(base, 0);
    const b = clamp01(add, 0);
    return clamp01(a + b * (1 - a), 0);
  }

  /**
   * @param {object} strike
   * @param {number} nowMs
   * @returns {{ absoluteFlash01: number, shadow01: number, env01: number, done: boolean }}
   * @private
   */
  _computeStrikeContribution(strike, nowMs) {
    const attackMs = Math.max(0, Number(this.params.flashAttackMs) || 0);
    const flickerHoldMs = Math.max(
      0,
      Number(strike.flickerHoldMs) || Number(this.params.flashFlickerHoldMs) || 1600,
    );
    const decayMs = Math.max(1, Number(strike.decayMs) || Number(this.params.flashDecayMs) || 1950);
    const curve = Math.max(0.15, Number(this.params.flashDecayCurve) || 0.72);
    const dtMs = Math.max(0, nowMs - strike.startMs);

    const env = this._computeStrikeEnvelope(dtMs, attackMs, flickerHoldMs, decayMs, curve, true);
    const peak = Math.max(0, strike.peak);

    const flickAmtBase = clamp01(this.params.flashFlickerAmount, 0.52);
    const flickAmt = strike.kind === 'small' ? flickAmtBase * 0.38 : flickAmtBase;
    const inFlickerHold = dtMs > attackMs && dtMs < attackMs + flickerHoldMs + 1;
    let flickMul = 1.0;
    if (flickAmt > 0 && inFlickerHold && flickerHoldMs > 0) {
      const holdElapsed = Math.max(0, dtMs - attackMs);
      const u = holdElapsed / flickerHoldMs;
      const organic = this._sampleOrganicFlicker(strike.flickerProfile, u);
      flickMul = (1 - flickAmt) + flickAmt * organic;
    }

    let flash = env * peak * flickMul;
    const clampV = Number.isFinite(Number(this.params.flashMaxClamp))
      ? Math.max(0, Number(this.params.flashMaxClamp))
      : 4;
    if (clampV > 0) flash = Math.min(flash, clampV);

    const scale = strike.manualBoost ? 1.0 : this._getEffectiveIntensityScale(strike.kind);
    const bright = clamp01(this.params.flashBrightness, 0.7) * scale;
    const fullPeak = clamp01(this.params.brightnessMax, 1) * bright;
    const strikeFlash01 = fullPeak > 0.001 ? clamp01(flash / fullPeak, 0) : 0;

    const shadowEnv = this._computeShadowEnvelope(dtMs, attackMs, flickerHoldMs, decayMs);
    let shadowOut = shadowEnv;
    if (inFlickerHold && flickMul < 0.999) {
      shadowOut *= flickMul;
    }
    const peakFrac = fullPeak > 0.001 ? clamp01(peak / fullPeak, 0) : 0;
    const shadow01 = clamp01(shadowOut * peakFrac, 0);

    const lightDone = env <= 0.0001;
    const shadowDone = shadowEnv <= 0.0001;
    return {
      strikeFlash01,
      shadow01,
      env01: env,
      flashValue: flash,
      done: lightDone && shadowDone,
    };
  }

  /**
   * @param {'small'|'big'|'auto'} [kind]
   */
  _beginStrike(kind = 'auto') {
    const strike = this._createStrikeRecord(kind);
    this._activeStrikes.push(strike);
    if (strike.manualBoost) this._manualStrikeBoost = true;
    this._flashStartMs = strike.startMs;
    this._flashPeak = Math.max(this._flashPeak, strike.peak);
    this._bakeCache.ensureReady({ floorCompositor: this._floorCompositor, params: this.params });
    this._rushBakeCacheForStrike();
    this._kickFlashEnvelopeAndRender();
  }

  /**
   * Publish flash state immediately and keep the render loop awake for the strike envelope.
   * Manual GM triggers fire outside `update()`, so without this idle throttling can skip
   * the entire flash before the first visible frame.
   * @private
   */
  _kickFlashEnvelopeAndRender() {
    const nowMs = performance.now();
    this._updateFlashEnvelope(nowMs, null);
    this._requestStrikeRenderLoop();
  }

  /**
   * @private
   */
  _requestStrikeRenderLoop() {
    try {
      const holdMs = Math.max(0, Number(this.params.flashFlickerHoldMs) || 550);
      const fadeScale = Math.max(1, Number(this.params.shadowFadeDurationScale) || 3.5);
      let durationMs = holdMs + (Number(this.params.flashDecayMs) || 1950) * fadeScale + 800;
      for (const strike of this._activeStrikes) {
        const decayMs = Math.max(1, Number(strike.decayMs) || Number(this.params.flashDecayMs) || 1950);
        const remaining = holdMs + decayMs * fadeScale + 800 - Math.max(0, performance.now() - strike.startMs);
        durationMs = Math.max(durationMs, remaining);
      }
      for (const item of this._seriesQueue) {
        const tail = Math.max(0, item.atMs - performance.now()) + holdMs + fadeScale * 4500 + 800;
        durationMs = Math.max(durationMs, tail);
      }
      window.MapShine?.renderLoop?.requestContinuousRender?.(durationMs);
    } catch (_) {}
  }

  /**
   * @returns {boolean}
   * @private
   */
  _canRunStrikeActivity() {
    if (!this._initialized) this.initialize();
    return resolveEffectEnabled(this);
  }

  /**
   * Complete shadow cache ASAP so the first GM strike can show directional shadows.
   * @private
   */
  _rushBakeCacheForStrike() {
    const fc = this._floorCompositor;
    if (!fc) return;
    const deps = { floorCompositor: fc, params: this.params };
    this._bakeCache.ensureReady(deps);
    let guard = 0;
    while (this._bakeCache.state === 'baking' && guard < 12) {
      this._bakeCache.tickBake(deps);
      guard += 1;
    }
  }

  /**
   * @returns {object|null}
   * @private
   */
  _buildLightningShadowTarget() {
    if (!Number.isFinite(Number(this._activeAzimuthDeg))) return null;
    return {
      azimuthDeg: this._activeAzimuthDeg,
      elevationDeg: DEFAULT_LIGHTNING_ELEVATION_DEG,
      lengthMul: Math.max(0.5, Number(this.params.shadowLengthScale) || 2.5),
      smearMul: Math.max(0.25, Number(this.params.shadowSmearScale) ?? 1),
      lengthScale: 1.0,
      smearScale: 1.0,
    };
  }

  /**
   * Lightning strike sun target for structural shadow passes and blend weighting.
   * @returns {object|null}
   */
  getLightningShadowTarget() {
    if (this._envShadowFlash01 <= 0) return null;
    return this._buildLightningShadowTarget();
  }

  /**
   * Lightning sun target for tree/bush billboard passes — held for the whole strike
   * envelope (not gated on per-frame flicker dips in {@link #_envShadowFlash01}).
   * @returns {object|null}
   */
  getVegetationLightningShadowTarget() {
    if (!this._hasActiveStrikes()) return null;
    return this._buildLightningShadowTarget();
  }

  /**
   * @deprecated Use {@link getLightningShadowTarget} + flash state `shadowFlash01`.
   * @returns {object|null}
   */
  getRuntimeShadowOverride() {
    const target = this.getLightningShadowTarget();
    if (!target) return null;
    return { ...target, blend01: this._envShadowFlash01 };
  }

  hasStrikeShadowSnapshot() {
    return this._strikeSnapshot.hasCapture();
  }

  /**
   * Copy lightning-direction shadow RTs after a live override render (peak of strike).
   * @param {import('../FloorCompositor.js').FloorCompositor} floorCompositor
   */
  captureStrikeShadowFromCompositor(floorCompositor) {
    this._strikeSnapshot.captureFromCompositor(floorCompositor, this._activeAzimuthDeg);
  }

  /**
   * Textures for ShadowManager blend: per-strike snapshot first, then compass bake cache.
   * Vegetation is omitted — billboard shadows are screen-space and must stay live while
   * the camera pans (see {@link wantsLiveVegetationLightningShadowOverride}).
   * @returns {{ building: THREE.Texture|null, skyReach: THREE.Texture|null, painted: THREE.Texture|null, vegetation: THREE.Texture|null }|null}
   */
  getShadowBlendTextures() {
    const snap = this._strikeSnapshot.getTextures();
    const fromBake = this._bakeCache.state === 'ready'
      ? this._bakeCache.getBlendedTextures(this._activeAzimuthDeg)
      : null;
    const base = snap ?? fromBake;
    if (!base) return null;
    return { ...base, vegetation: null };
  }

  /**
   * Whether structural passes should use live lightning sun override this frame.
   * @returns {boolean}
   */
  wantsLiveLightningShadowOverride() {
    if (this._envShadowFlash01 <= 0) return false;
    if (!this.getLightningShadowTarget()) return false;
    // After snapshot: fade via fixed lightning texture blend only (no sun-angle lerp).
    return !this._strikeSnapshot.hasCapture();
  }

  /**
   * Tree/bush billboard shadows are rendered into screen-space RTs; keep lightning
   * sun override live for the whole shadow flash so panning does not drag a frozen mask.
   * @returns {boolean}
   */
  wantsLiveVegetationLightningShadowOverride() {
    return !!this.getVegetationLightningShadowTarget();
  }

  triggerSmallStrike() {
    if (!this._canRunStrikeActivity()) return;
    this._beginStrike('small');
  }

  triggerBigStrike() {
    if (!this._canRunStrikeActivity()) return;
    this._beginStrike('big');
  }

  /**
   * @param {number} [durationMs]
   */
  triggerStrikeSeries(durationMs = 30000) {
    if (!this._canRunStrikeActivity()) return;
    const dur = Math.max(5000, Number(durationMs) || 30000);
    const count = 12 + Math.floor(Math.random() * 14);
    const queue = [];
    for (let i = 0; i < count; i++) {
      queue.push({
        atMs: performance.now() + Math.random() * dur,
        kind: Math.random() < 0.14 ? 'big' : 'small',
      });
    }
    queue.sort((a, b) => a.atMs - b.atMs);
    this._seriesQueue = queue;
    this._bakeCache.ensureReady({ floorCompositor: this._floorCompositor, params: this.params });
    this._requestStrikeRenderLoop();
  }

  /**
   * Snapshot for shadow / lighting consumers.
   * @returns {object}
   */
  getFlashState() {
    const dayNightMul = this._resolveDayNightFlashMultiplier();
    const shadow01 = clamp01(this._envShadowFlash01 * dayNightMul, 0);
    return {
      flash01: clamp01(this._envFlash01 * dayNightMul, 0),
      dayNightFlashMul: dayNightMul,
      shadowFlash01: shadow01,
      flash: this._flashValue,
      azimuthDeg: this._activeAzimuthDeg,
      // Weight is per-strike strength only; flash01 carries the fade envelope.
      shadowWeight: this._strikeShadowWeight,
      bakeReady: this._bakeCache.state === 'ready',
      textures: this.getShadowBlendTextures(),
      hasStrikeSnapshot: this._strikeSnapshot.hasCapture(),
    };
  }

  _ensureEnvironment() {
    const ms = window.MapShine;
    if (!ms) return null;
    if (!ms.environment) ms.environment = {};
    return ms.environment;
  }

  /**
   * Circular hour distance (0..12).
   * @param {number} hour
   * @param {number} anchorHour
   * @returns {number}
   * @private
   */
  _hourDistance(hour, anchorHour) {
    const d = getClockwiseHourDelta(anchorHour, hour);
    return Math.min(d, 24 - d);
  }

  /**
   * Smooth falloff around a phase anchor hour.
   * @param {number} hour
   * @param {number} anchorHour
   * @param {number} spreadHours
   * @param {number} sharpness
   * @returns {number}
   * @private
   */
  _hourAnchorInfluence(hour, anchorHour, spreadHours, sharpness) {
    const spread = Math.max(0.25, spreadHours);
    const dist = this._hourDistance(hour, anchorHour);
    if (dist >= spread) return 0;
    const t = 1 - dist / spread;
    return Math.pow(smoothstep01(t), Math.max(0.2, sharpness));
  }

  /**
   * 0 at sunset/sunrise, 1 at midnight on the night arc.
   * @param {number} hour
   * @param {object} phases
   * @param {number} sharpness
   * @returns {number}
   * @private
   */
  _nightArcInfluence(hour, phases, sharpness) {
    const progress = getWrappedHourProgress(hour, phases.sunset, phases.sunrise);
    if (!Number.isFinite(progress)) return 0;
    return Math.pow(Math.max(0, Math.sin(Math.PI * progress)), Math.max(0.2, sharpness));
  }

  /**
   * Darkness-only fallback when Map Shine hour is unavailable.
   * @param {number} darkness
   * @param {number} dayMul
   * @param {number} dawnMul
   * @param {number} duskMul
   * @param {number} nightMul
   * @param {number} sharpness
   * @returns {number}
   * @private
   */
  _resolveFlashMultiplierFromDarkness(darkness, dayMul, dawnMul, duskMul, nightMul, sharpness) {
    const d = clamp01(darkness, 0);
    const twilightDark = 0.55;
    const twilightBand = 0.14;
    if (Math.abs(d - twilightDark) <= twilightBand) {
      const twilightMul = (dawnMul + duskMul) * 0.5;
      const nightBlend = clamp01((d - (twilightDark - twilightBand)) / (twilightBand * 2), 0);
      const nightT = Math.pow(nightBlend, sharpness);
      return twilightMul + (nightMul - twilightMul) * nightT;
    }
    if (d < twilightDark - twilightBand) {
      const dayT = Math.pow(1 - d / Math.max(0.001, twilightDark - twilightBand), sharpness);
      return dayMul + (dawnMul - dayMul) * (1 - dayT) * 0.35;
    }
    const nightT = Math.pow((d - (twilightDark + twilightBand)) / Math.max(0.001, 1 - twilightDark - twilightBand), sharpness);
    const twilightMul = (dawnMul + duskMul) * 0.5;
    return twilightMul + (nightMul - twilightMul) * clamp01(nightT, 0);
  }

  /**
   * Scale flash strength by time-of-day anchors (day, dawn, dusk, night).
   * @returns {number}
   */
  _resolveDayNightFlashMultiplier() {
    const dayMul = Math.max(0, Number(this.params.dayFlashBrightnessScale) ?? 0.2);
    const dawnMul = Math.max(0, Number(this.params.dawnFlashBrightnessScale) ?? dayMul);
    const duskMul = Math.max(0, Number(this.params.duskFlashBrightnessScale) ?? dayMul);
    const nightMul = Math.max(0, Number(this.params.nightFlashBrightnessScale) ?? 1);
    const sharpness = Math.max(0.2, Number(this.params.dayNightFlashCurve) ?? 1.35);
    const twilightSpread = Math.max(0.5, Number(this.params.twilightFlashBlendHours) ?? 2.5);

    let hour = Number.NaN;
    let darkness = 0;
    try {
      const state = LightingDirector.get();
      hour = Number(state?.hour);
      darkness = clamp01(state?.masterDarkness, 0);
    } catch (_) {
      try {
        const raw = Number(canvas?.scene?.environment?.darknessLevel)
          ?? Number(canvas?.environment?.darknessLevel);
        if (Number.isFinite(raw)) darkness = clamp01(raw, 0);
      } catch (_) {}
    }

    if (!Number.isFinite(hour)) {
      return this._resolveFlashMultiplierFromDarkness(
        darkness, dayMul, dawnMul, duskMul, nightMul, sharpness,
      );
    }

    const phases = getFoundryTimePhaseHours();
    const h = ((hour % 24) + 24) % 24;
    const noonSpread = twilightSpread * 1.35;
    const midnightSpread = twilightSpread * 1.6;

    const wDawn = this._hourAnchorInfluence(h, phases.dawn, twilightSpread, sharpness);
    const wDusk = this._hourAnchorInfluence(h, phases.dusk, twilightSpread, sharpness);
    let wNoon = this._hourAnchorInfluence(h, phases.noon, noonSpread, sharpness * 0.85);
    const wNight = this._nightArcInfluence(h, phases, sharpness);

    const twilightOverlap = Math.min(1, wDawn + wDusk);
    wNoon *= 1 - twilightOverlap * 0.9;

    let sumW = wDawn + wDusk + wNoon + wNight;
    if (sumW < 1e-5) {
      const dayProgress = getWrappedHourProgress(h, phases.sunrise, phases.sunset);
      if (Number.isFinite(dayProgress)) {
        return dayMul;
      }
      return this._resolveFlashMultiplierFromDarkness(
        darkness, dayMul, dawnMul, duskMul, nightMul, sharpness,
      );
    }

    const mul = (
      dawnMul * wDawn
      + duskMul * wDusk
      + dayMul * wNoon
      + nightMul * wNight
    ) / sumW;
    return Math.max(0, mul);
  }

  _publishEnvironment(timeInfo) {
    const env = this._ensureEnvironment();
    if (!env) return;
    const dayNightMul = this._resolveDayNightFlashMultiplier();
    env.landscapeLightningDayNightMul = dayNightMul;
    env.landscapeLightningFlash = this._flashValue;
    env.landscapeLightningFlash01 = clamp01(this._envFlash01 * dayNightMul, 0);
    env.landscapeLightningAzimuthDeg = this._activeAzimuthDeg;
    env.landscapeLightningStrikeTime = timeInfo?.elapsed ?? 0;
    const flash01 = clamp01(this._envFlash01, 0);
    const bright = clamp01(this.params.flashBrightness, 0.7) * this._getEffectiveIntensityScale('auto');
    const peakMul = Math.max(1, Number(this.params.windowFlashPeakMultiplier) || 9);
    const strike01 = flash01 * bright * dayNightMul;
    env.landscapeLightningWindowMul = 1.0 + strike01 * Math.max(0, peakMul - 1);
    env.landscapeLightningOutdoorStrength = strike01
      * Math.max(0, Number(this.params.outdoorFlashStrength) || 7.5);
    env.landscapeLightningShadowFlashFloor = clamp01(this.params.lightningShadowFlashFloor, 0.06);
    env.landscapeLightningShadowFlashGamma = Math.max(0.1, Number(this.params.lightningShadowFlashGamma) || 0.72);
    env.landscapeLightningFlashContrast = Math.max(0, Number(this.params.lightningFlashContrast) || 1.15);
    env.landscapeLightningShadowDarkness = Math.max(1, Number(this.params.lightningShadowDarkness) || 2.4);
    const colorR = Number(this.params.lightningFlashColorR);
    const colorG = Number(this.params.lightningFlashColorG);
    const colorB = Number(this.params.lightningFlashColorB);
    env.landscapeLightningFlashColorR = Number.isFinite(colorR) ? colorR : 0.68;
    env.landscapeLightningFlashColorG = Number.isFinite(colorG) ? colorG : 0.82;
    env.landscapeLightningFlashColorB = Number.isFinite(colorB) ? colorB : 1.0;
  }

  /**
   * @returns {{ r: number, g: number, b: number }}
   */
  getLightningFlashColor() {
    const r = Number(this.params.lightningFlashColorR);
    const g = Number(this.params.lightningFlashColorG);
    const b = Number(this.params.lightningFlashColorB);
    return {
      r: Number.isFinite(r) ? r : 0.68,
      g: Number.isFinite(g) ? g : 0.82,
      b: Number.isFinite(b) ? b : 1.0,
    };
  }

  /**
   * Build a unique irregular brightness path for one strike's flicker-hold window.
   * @param {number} seed
   * @param {'small'|'big'|'auto'} kind
   * @param {number} chaosRate
   * @returns {{ knots: {t:number,v:number}[], dips: object[], surges: object[], seed: number, flutterBins: number }}
   * @private
   */
  _buildOrganicFlickerProfile(seed, kind, chaosRate) {
    const chaos = Math.max(0.15, Math.min(3.5, chaosRate / 11));
    const seedBase = seed * 1000 + (kind === 'big' ? 500 : kind === 'small' ? 100 : 0);
    const knotCount = 2 + Math.floor(2 + flickerHash01(seedBase) * (3 + chaos * 4));

    const knots = [];
    let cursor = 0;
    knots.push({ t: 0, v: 0.88 + flickerHash01(seedBase + 1.3) * 0.12 });

    for (let i = 0; i < knotCount; i++) {
      const gap = (0.04 + flickerHash01(seedBase + i * 19.7) * (0.32 - chaos * 0.04)) / Math.max(0.35, chaos * 0.55);
      cursor = Math.min(0.96, cursor + gap);
      const roll = flickerHash01(seedBase + i * 41.2);
      let v;
      if (roll < 0.38) {
        v = 0.05 + flickerHash01(seedBase + i * 5.1) * 0.38;
      } else if (roll < 0.78) {
        v = 0.42 + flickerHash01(seedBase + i * 7.9) * 0.38;
      } else {
        v = 0.78 + flickerHash01(seedBase + i * 11.3) * 0.22;
      }
      knots.push({ t: cursor, v });
    }
    knots.push({ t: 1, v: 0.28 + flickerHash01(seedBase + 77) * 0.5 });
    knots.sort((a, b) => a.t - b.t);

    const merged = [knots[0]];
    for (let k = 1; k < knots.length; k++) {
      const prev = merged[merged.length - 1];
      if (knots[k].t - prev.t < 0.025) {
        prev.v = (prev.v + knots[k].v) * 0.5;
        prev.t = knots[k].t;
      } else {
        merged.push(knots[k]);
      }
    }

    const dips = [];
    const dipCount = Math.floor(1 + flickerHash01(seedBase + 5.2) * (1 + chaos * 2.5));
    for (let j = 0; j < dipCount; j++) {
      dips.push({
        center: 0.04 + flickerHash01(seedBase + j * 29.1) * 0.92,
        width: 0.006 + flickerHash01(seedBase + j * 31.4) * (0.04 / chaos),
        depth: 0.2 + flickerHash01(seedBase + j * 37.8) * 0.65,
      });
    }

    const surges = [];
    const surgeCount = Math.floor(flickerHash01(seedBase + 9.1) * (1 + chaos * 1.8));
    for (let s = 0; s < surgeCount; s++) {
      surges.push({
        center: 0.06 + flickerHash01(seedBase + s * 43.2) * 0.88,
        width: 0.012 + flickerHash01(seedBase + s * 47.6) * 0.05,
        amp: 0.06 + flickerHash01(seedBase + s * 53.1) * 0.28,
      });
    }

    const flutterBins = Math.floor(6 + chaos * 22 + (kind === 'big' ? 6 : 0));
    return { knots: merged, dips, surges, seed: seedBase, flutterBins };
  }

  /**
   * Sample the per-strike organic flicker curve (0..1).
   * @param {object|null} profile
   * @param {number} u normalized time through flicker hold (0..1)
   * @returns {number}
   * @private
   */
  _sampleOrganicFlicker(profile, u) {
    if (!profile) return 1;
    const t = Math.max(0, Math.min(1, u));
    const { knots, dips, surges, seed, flutterBins } = profile;

    let v = knots[0]?.v ?? 1;
    for (let i = 0; i < knots.length - 1; i++) {
      const a = knots[i];
      const b = knots[i + 1];
      if (t >= a.t && t <= b.t) {
        const span = Math.max(1e-5, b.t - a.t);
        const local = (t - a.t) / span;
        v = a.v + (b.v - a.v) * smoothstep01(local);
        break;
      }
    }
    if (t >= knots[knots.length - 1].t) {
      v = knots[knots.length - 1].v;
    }

    for (const d of dips) {
      const dist = Math.abs(t - d.center) / Math.max(1e-4, d.width);
      if (dist < 1) {
        const fall = 1 - dist * dist;
        v *= 1 - d.depth * fall;
      }
    }

    for (const s of surges) {
      const dist = Math.abs(t - s.center) / Math.max(1e-4, s.width);
      if (dist < 1) {
        const rise = 1 - dist * dist;
        v += s.amp * rise;
      }
    }

    const bins = Math.max(4, flutterBins | 0);
    const binF = t * bins;
    const bin = Math.floor(binF);
    const binT = binF - bin;
    const h0 = flickerHash01(seed + bin * 17.13);
    const h1 = flickerHash01(seed + (bin + 1) * 17.13);
    const flutter = h0 + (h1 - h0) * smoothstep01(binT);
    v *= 0.62 + 0.38 * flutter;

    const grain = flickerHash01(seed + t * 311.7 + Math.floor(t * 180) * 0.41);
    v *= 0.88 + 0.12 * grain;

    return clamp01(v, 0.5);
  }

  /**
   * Strike envelope: instant peak → flicker hold → slow fade.
   * @param {number} dtMs
   * @param {number} attackMs
   * @param {number} flickerHoldMs
   * @param {number} decayMs
   * @param {number} decayCurve
   * @param {boolean} [smoothTail]
   * @returns {number} 0..1
   */
  _computeStrikeEnvelope(dtMs, attackMs, flickerHoldMs, decayMs, decayCurve, smoothTail = true) {
    const attack = Math.max(0, attackMs);
    const hold = Math.max(0, flickerHoldMs);
    const decay = Math.max(1, decayMs);
    const curve = Math.max(0.15, decayCurve);

    if (dtMs <= attack) {
      return attack <= 0 ? 1.0 : Math.min(1, dtMs / Math.max(1, attack));
    }
    const afterAttack = dtMs - attack;
    if (afterAttack < hold) return 1.0;

    const t = (afterAttack - hold) / decay;
    let env = Math.pow(Math.max(0, 1 - t), curve);
    if (smoothTail) env = env * env * (3 - 2 * env);
    return Math.max(0, Math.min(1, env));
  }

  /**
   * @param {number} dtMs
   * @param {number} attackMs
   * @param {number} flickerHoldMs
   * @param {number} decayMs
   * @returns {number}
   */
  _computeShadowEnvelope(dtMs, attackMs, flickerHoldMs, decayMs) {
    const fadeScale = Math.max(1, Number(this.params.shadowFadeDurationScale) || 3.5);
    const fadeCurve = Math.max(0.15, Number(this.params.shadowFadeCurve) || 0.48);
    return this._computeStrikeEnvelope(
      dtMs,
      attackMs,
      flickerHoldMs,
      Math.max(1, decayMs * fadeScale),
      fadeCurve,
      true,
    );
  }

  _syncDominantStrikeSnapshot(dominantStrike) {
    if (!dominantStrike) return;
    const az = dominantStrike.azimuthDeg;
    const prev = this._snapshotAzimuthDeg;
    const drift = Number.isFinite(prev)
      ? Math.min(Math.abs(az - prev), 360 - Math.abs(az - prev))
      : Infinity;
    if (!Number.isFinite(prev) || drift > 18) {
      this._strikeSnapshot.clear();
      this._snapshotAzimuthDeg = az;
    }
  }

  _updateFlashEnvelope(nowMs, timeInfo) {
    if (!this._hasActiveStrikes()) {
      if (this._flashValue !== 0 || this._envFlash01 !== 0 || this._envShadowFlash01 !== 0) {
        this._flashValue = 0;
        this._envFlash01 = 0;
        this._envShadowFlash01 = 0;
        this._flashStartMs = -1;
        this._flashPeak = 0;
        this._manualStrikeBoost = false;
        this._strikeSnapshot.clear();
        this._snapshotAzimuthDeg = Number.NaN;
      }
      this._publishEnvironment(timeInfo);
      return;
    }

    let combinedFlash01 = 0;
    let combinedShadow01 = 0;
    let combinedFlashValue = 0;
    let dominantStrike = null;
    let dominantFlash = 0;
    let earliestStart = Infinity;
    let maxPeak = 0;

    for (let i = this._activeStrikes.length - 1; i >= 0; i--) {
      const strike = this._activeStrikes[i];
      const contrib = this._computeStrikeContribution(strike, nowMs);
      if (contrib.done) {
        this._activeStrikes.splice(i, 1);
        continue;
      }
      earliestStart = Math.min(earliestStart, strike.startMs);
      maxPeak = Math.max(maxPeak, strike.peak);
      combinedFlash01 = this._blendFlashContribution(combinedFlash01, contrib.strikeFlash01);
      combinedShadow01 = Math.max(combinedShadow01, contrib.shadow01);
      combinedFlashValue = Math.max(combinedFlashValue, contrib.flashValue);
      if (contrib.strikeFlash01 > dominantFlash) {
        dominantFlash = contrib.strikeFlash01;
        dominantStrike = strike;
      }
    }

    if (!this._hasActiveStrikes()) {
      this._flashValue = 0;
      this._envFlash01 = 0;
      this._envShadowFlash01 = 0;
      this._flashStartMs = -1;
      this._flashPeak = 0;
      this._manualStrikeBoost = false;
      this._strikeSnapshot.clear();
      this._snapshotAzimuthDeg = Number.NaN;
      this._publishEnvironment(timeInfo);
      return;
    }

    if (dominantStrike) {
      this._activeAzimuthDeg = dominantStrike.azimuthDeg;
      this._strikeShadowWeight = dominantStrike.strikeShadowWeight;
      this._syncDominantStrikeSnapshot(dominantStrike);
    }

    this._manualStrikeBoost = this._activeStrikes.some((s) => s.manualBoost);
    this._flashStartMs = Number.isFinite(earliestStart) ? earliestStart : -1;
    this._flashPeak = maxPeak;
    this._flashValue = combinedFlashValue;
    this._envFlash01 = combinedFlash01;
    this._envShadowFlash01 = combinedShadow01;

    this._publishEnvironment(timeInfo);
  }

  update(timeInfo) {
    if (!this._initialized) return;

    const nowMs = performance.now();
    const stormOn = this.enabled && this.params.enabled && clamp01(this.params.stormIntensity, 0) > 0.001;

    if (!this._nextAutoStrikeMs) {
      const { min, max } = this._resolveDelayRange();
      this._nextAutoStrikeMs = nowMs + min + Math.random() * (max - min);
    }

    if (stormOn || this._hasActiveStrikes() || this._seriesQueue.length) {
      this._bakeCache.ensureReady({ floorCompositor: this._floorCompositor, params: this.params });
      this._bakeCache.tickBake({ floorCompositor: this._floorCompositor, params: this.params });
    }

    for (let i = this._seriesQueue.length - 1; i >= 0; i--) {
      if (nowMs >= this._seriesQueue[i].atMs) {
        const item = this._seriesQueue.splice(i, 1)[0];
        this._beginStrike(item.kind);
      }
    }

    if (stormOn && nowMs >= this._nextAutoStrikeMs) {
      this._beginStrike('auto');
      const { min, max } = this._resolveDelayRange();
      const intensity = clamp01(this.params.stormIntensity, 0);
      const scale = 0.4 + (1 - intensity) * 0.6;
      this._nextAutoStrikeMs = nowMs + (min + Math.random() * (max - min)) * scale;
    }

    this._updateFlashEnvelope(nowMs, timeInfo);
  }

  render() {}

  wantsContinuousRender() {
    return (
      (this.enabled && this.params.enabled && clamp01(this.params.stormIntensity, 0) > 0)
      || this._hasActiveStrikes()
      || this._envShadowFlash01 > 0.001
      || this._seriesQueue.length > 0
      || this._bakeCache.state === 'baking'
    );
  }

  dispose() {
    this._activeStrikes = [];
    this._seriesQueue = [];
    this._bakeCache.dispose();
    this._strikeSnapshot.dispose();
    this._floorCompositor = null;
  }
}
