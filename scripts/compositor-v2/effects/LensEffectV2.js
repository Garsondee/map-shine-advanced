/**
 * @fileoverview LensEffectV2 — stylized post-processing lens treatment.
 *
 * Multiple overlay textures can be layered at once across 4 slots.
 * Exception: textures named lens_overlay_* are mutually exclusive globally
 * (at most one such texture active across all slots).
 * The catalog of available textures is
 * auto-discovered at initialize() time by scanning assets/lens assets/ via
 * Foundry's FilePicker API — any image dropped into that folder is picked up
 * automatically without code changes.
 *
 * Shader execution order:
 *   overlay Add (screen-space) → distortion → CA → vignette → grain
 */

import { createLogger } from '../../core/log.js';
import { getGlobalFrameState } from '../../core/frame-state.js';
import { getVertexShader, getFragmentShader } from './lens-shader.js';

const log = createLogger('LensEffectV2');

/** Module-relative path to the folder that holds lens overlay images. */
const LENS_ASSET_DIR = 'modules/map-shine-advanced/assets/lens assets';
const LENS_ASSET_DIR_VARIANTS = [
  'modules/map-shine-advanced/assets/lens assets',
  'modules/map-shine-advanced/assets/lens-assets',
  'modules/map-shine-advanced/assets/lens_assets',
];
const OVERLAY_SLOT_COUNT = 4;

const FALLBACK_OVERLAY_FILES = [
  'lens_dust_01.jpg',
  'lens_grease_01.jpg',
  'lens_grease_02.jpg',
  'lens_grease_03.jpg',
  'lens_leak_01.jpg',
  'lens_leak_02.jpg',
  'lens_overlay_01.jpg',
  'lens_overlay_02.jpg',
  'lens_scratches_01.jpg',
  'light_leak_01.jpg',
  'light_leak_02.jpg',
  'rainbow_chroma_01.jpg',
  'rainbow_chroma_02.jpg',
];

/** Image extensions accepted as overlay textures. */
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|avif)$/i;

/** Reactivity defaults keyed by filename token (first underscore-separated word). */
const GROUP_DEFAULTS = {
  lens:   { lumaReactivity: 0.25, lumaBoost: 1.4, clearRadius: 0.0,  clearSoftness: 0.10, pulseMag: 0.05, pulseFreq: 0.08 },
  light:  { lumaReactivity: 0.85, lumaBoost: 2.8, clearRadius: 0.28, clearSoftness: 0.14, pulseMag: 0.12, pulseFreq: 0.18 },
  rainbow:{ lumaReactivity: 0.80, lumaBoost: 2.5, clearRadius: 0.28, clearSoftness: 0.14, pulseMag: 0.10, pulseFreq: 0.16 },
};
const DEFAULT_GROUP = { lumaReactivity: 0.35, lumaBoost: 1.5, clearRadius: 0.0, clearSoftness: 0.10, pulseMag: 0.06, pulseFreq: 0.10 };

const VIEWFINDER_NAMES = ['lens_overlay_01', 'lens_overlay_02'];
const STRUCTURAL_NAMES = ['lens_dust_01', 'lens_grease_01', 'lens_grease_02', 'lens_grease_03', 'lens_scratches_01'];
const OPTICAL_NAMES = ['lens_leak_01', 'lens_leak_02'];
const REACTIVE_NAMES = ['light_leak_01', 'light_leak_02', 'rainbow_chroma_01', 'rainbow_chroma_02'];

function uniqueNames(names) {
  return [...new Set((names || []).map(n => String(n || '').trim().toLowerCase()).filter(Boolean))];
}

function makeTextureOptions(names, { includeNone = false, includeAuto = true } = {}) {
  const options = {};
  if (includeNone) options.None = 'none';
  if (includeAuto) options.Auto = 'auto';
  for (const name of uniqueNames(names)) {
    options[name] = name;
  }
  return options;
}

function isLensOverlayName(name) {
  return /^lens_overlay_\d+/i.test(String(name || ''));
}

function buildOverlayUrlCandidates(rawPath) {
  const candidates = [];
  const seen = new Set();
  const push = (v) => {
    const value = String(v || '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    candidates.push(value);
  };

  const raw = String(rawPath || '');
  push(raw);
  try { push(decodeURI(raw)); } catch (_) {}
  try { push(encodeURI(decodeURI(raw))); } catch (_) {}

  const baseCandidates = [...candidates];
  const patterns = [
    ['/lens%2520assets/', '/lens assets/'],
    ['/lens%20assets/', '/lens assets/'],
    ['/lens-assets/', '/lens assets/'],
    ['/lens_assets/', '/lens assets/'],
  ];

  for (const base of baseCandidates) {
    let normalized = base;
    for (const [from, to] of patterns) {
      normalized = normalized.replace(from, to);
    }
    push(normalized);
    push(normalized.replace('/lens assets/', '/lens-assets/'));
    push(normalized.replace('/lens assets/', '/lens_assets/'));
    try { push(encodeURI(normalized)); } catch (_) {}
  }

  return candidates;
}

function groupDefaultsForFile(name) {
  const prefix = (name || '').toLowerCase().split('_')[0];
  return GROUP_DEFAULTS[prefix] ?? DEFAULT_GROUP;
}

function makeCatalogFromPaths(paths) {
  return (paths || [])
    .filter(f => IMAGE_EXT_RE.test(f))
    .sort((a, b) => String(a).localeCompare(String(b)))
    .map((f, i) => {
      const file = String(f).split('/').pop() || '';
      const name = file.replace(/\.[^.]+$/, '');
      return { index: i, name, path: String(f), group: groupDefaultsForFile(name) };
    });
}

/** Cover-fit UV scale+offset so any texture fills any screen without stretching. */
function computeCoverScaleOffset(texW, texH, screenW, screenH) {
  const ta = Math.max(1, texW) / Math.max(1, texH);
  const sa = Math.max(1, screenW) / Math.max(1, screenH);
  if (sa > ta) {
    const sy = ta / sa;
    return { sx: 1, sy, ox: 0, oy: (1 - sy) * 0.5 };
  }
  const sx = sa / ta;
  return { sx, sy: 1, ox: (1 - sx) * 0.5, oy: 0 };
}

function clamp01(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }

export class LensEffectV2 {
  constructor() {
    this._initialized = false;

    /** @type {THREE.TextureLoader|null} */
    this._loader = null;

    this._composeScene    = null;
    this._composeCamera   = null;
    this._composeMaterial = null;
    this._composeQuad     = null;
    this._fallbackBlack   = null;

    /**
     * Catalog entries discovered by FilePicker at init time.
     * @type {Array<{index:number, name:string, path:string, group:object}>}
     */
    this._catalog = [];
    /** @type {Map<string, number>} */
    this._catalogNameToIndex = new Map();
    /** @type {Set<string>} */
    this._catalogNameSet = new Set();

    /** @type {Array<THREE.Texture|null>} */
    this._slotTextures = new Array(OVERLAY_SLOT_COUNT).fill(null);
    /** @type {Array<THREE.Texture|null>} */
    this._slotPrevTextures = new Array(OVERLAY_SLOT_COUNT).fill(null);
    /** @type {Array<number>} */
    this._slotLoadedIndices = new Array(OVERLAY_SLOT_COUNT).fill(-2); // force first sync
    /** @type {Array<number>} */
    this._slotBlendT = new Array(OVERLAY_SLOT_COUNT).fill(1);
    /** @type {Array<number>} */
    this._slotBlendDurationSec = new Array(OVERLAY_SLOT_COUNT).fill(0.8);
    this._currentScreenW = 1;
    this._currentScreenH = 1;
    this._smoothedSceneLuma = 0.5;
    this._lastUpdateElapsedSec = null;
    this._lastUpdateDeltaSec = 1 / 60;
    this._lumaReadPixel = null;

    this._autoFocusEventActive = false;
    this._autoFocusEventElapsedSec = 0;
    this._autoFocusEventDurationSec = 0.35;
    this._autoFocusTimeToNextEventSec = 60;
    this._autoFocusZoomCooldownSec = 0;
    this._autoFocusShiftPx = { x: 0, y: 0 };
    this._autoFocusAmount = 0;

    this._cameraMotionPx = { x: 0, y: 0 };
    this._cameraMotionSmoothedPx = { x: 0, y: 0 };
    this._cameraMotionBlurPx = { x: 0, y: 0 };
    this._zoomMotionBlurPx = 0;
    this._cameraZoomVelocity = 0;
    this._lastCameraFrame = null;
    this._lightBurnDarknessGate = 1.0;

    this._lightBurnScene = null;
    this._lightBurnCamera = null;
    this._lightBurnMaterial = null;
    this._lightBurnQuad = null;
    this._lightBurnReadRT = null;
    this._lightBurnWriteRT = null;
    this._lightBurnWidth = 0;
    this._lightBurnHeight = 0;

    this.params = {
      enabled: false,

      // High-level lens layering model.
      dynamicLayersEnabled: true,
      layerCycleSeconds: 36,
      lumaSmoothingSeconds: 1,
      layerSwapFadeSeconds: 0.8,

      autoFocusEnabled: true,
      autoFocusMinIntervalSeconds: 45,
      autoFocusMaxIntervalSeconds: 130,
      autoFocusDefocusDurationSeconds: 2,
      autoFocusMaxBlurPx: 2.75,
      autoFocusMaxShiftPx: 6,
      autoFocusZoomTriggerEnabled: true,
      autoFocusZoomTriggerThreshold: 3,
      autoFocusZoomTriggerCooldownSeconds: 6,
      autoFocusZoomTriggerStrength: 0.3,

      lightBurnEnabled: true,
      lightBurnThreshold: 0.99,
      lightBurnThresholdSoftness: 0.5,
      lightBurnPersistenceSeconds: 0.1,
      lightBurnResponse: 1.15,
      lightBurnIntensity: 0.15,
      lightBurnBlurPx: 8,
      lightBurnDarknessGateEnabled: true,
      lightBurnDarknessStart: 0.45,
      lightBurnDarknessEnd: 0.78,
      lightBurnDarknessInfluence: 1.0,

      motionBlurEnabled: false,
      motionBlurStrength: 1.77,
      motionBlurMaxPx: 10,
      motionBlurZoomStrength: 1.25,
      motionBlurSmoothingSeconds: 0.8,

      structuralSelection: 'auto',
      structuralIntensity: 0.6,
      structuralLumaReactivity: 1,
      structuralLumaBoost: 4,
      structuralLumaMin: 0,
      structuralLumaMax: 1,
      structuralLumaInfluence: 1,
      structuralClearRadius: 0.43,
      structuralClearSoftness: 0.10,
      structuralDriftX: 0.00006,
      structuralDriftY: 0.00004,
      structuralPulseMag: 0.19,
      structuralPulseFreq: 0.08,

      opticalSelection: 'auto',
      opticalIntensity: 1.53,
      opticalLumaReactivity: 1,
      opticalLumaBoost: 1.15,
      opticalLumaMin: 0,
      opticalLumaMax: 1,
      opticalLumaInfluence: 0.47,
      opticalClearRadius: 0.28,
      opticalClearSoftness: 0.12,
      opticalDriftX: 0.00005,
      opticalDriftY: 0.00005,
      opticalPulseMag: 0.17,
      opticalPulseFreq: 0.11,

      reactiveSelection: 'light_leak_02',
      reactiveIntensity: 0.97,
      reactiveLumaReactivity: 1,
      reactiveLumaBoost: 1.95,
      reactiveLumaMin: 0,
      reactiveLumaMax: 1,
      reactiveLumaInfluence: 0.53,
      reactiveClearRadius: 0.28,
      reactiveClearSoftness: 0.14,
      reactiveDriftX: 0.00010,
      reactiveDriftY: 0.00006,
      reactivePulseMag: 0.11,
      reactivePulseFreq: 0.17,

      viewfinderEnabled: true,
      viewfinderSelection: 'none',
      viewfinderIntensity: 0.6,
      viewfinderLumaReactivity: 0.1,
      viewfinderLumaBoost: 1.1,
      viewfinderDriftX: 0.0,
      viewfinderDriftY: 0.0,
      viewfinderPulseMag: 0.0,
      viewfinderPulseFreq: 0.0,

      // Overlay slots: -1 = disabled, otherwise catalog index.
      overlayIndex0: -1,
      overlayIndex1: -1,
      overlayIndex2: -1,
      overlayIndex3: -1,

      // Per-slot tuning.
      overlayIntensity0:      0.80,
      overlayLumaReactivity0: 0.35,
      overlayLumaBoost0:      1.50,
      overlayClearRadius0:    0.00,
      overlayClearSoftness0:  0.10,
      overlayDriftX0:         0.00008,
      overlayDriftY0:         0.00005,
      overlayPulseMag0:       0.06,
      overlayPulseFreq0:      0.10,
      overlayPulsePhase0:     0.0,

      overlayIntensity1:      0.80,
      overlayLumaReactivity1: 0.35,
      overlayLumaBoost1:      1.50,
      overlayClearRadius1:    0.00,
      overlayClearSoftness1:  0.10,
      overlayDriftX1:         0.00008,
      overlayDriftY1:         0.00005,
      overlayPulseMag1:       0.06,
      overlayPulseFreq1:      0.10,
      overlayPulsePhase1:     1.5,

      overlayIntensity2:      0.80,
      overlayLumaReactivity2: 0.35,
      overlayLumaBoost2:      1.50,
      overlayClearRadius2:    0.00,
      overlayClearSoftness2:  0.10,
      overlayDriftX2:         0.00008,
      overlayDriftY2:         0.00005,
      overlayPulseMag2:       0.06,
      overlayPulseFreq2:      0.10,
      overlayPulsePhase2:     3.0,

      overlayIntensity3:      0.80,
      overlayLumaReactivity3: 0.35,
      overlayLumaBoost3:      1.50,
      overlayClearRadius3:    0.00,
      overlayClearSoftness3:  0.10,
      overlayDriftX3:         0.00008,
      overlayDriftY3:         0.00005,
      overlayPulseMag3:       0.06,
      overlayPulseFreq3:      0.10,
      overlayPulsePhase3:     4.5,

      // Core lens controls.
      distortionAmount:   -0.07,
      distortionCenterX:  0.5,
      distortionCenterY:  0.5,
      chromaticAmountPx:  4.22,
      chromaticEdgePower: 2.11,
      vignetteIntensity:  1,
      vignetteSoftness:   0.34,
      grainAmount:        0.01,
      grainSpeed:         1.0,
      adaptiveGrainEnabled: true,
      grainLowLightBoost: 0.25,
      grainCellSizeBright: 1.4,
      grainCellSizeDark: 3,
      digitalNoiseEnabled: false,
      digitalNoiseAmount: 0.066,
      digitalNoiseChance: 0.004,
      digitalNoiseGreenBias: 1,
      digitalNoiseLowLightBoost: 3.37,
    };
  }

  get enabled() { return !!this.params.enabled; }
  set enabled(v) { this.params.enabled = !!v; }

  /** Read-only catalog for UI consumers. */
  get catalog() { return this._catalog; }

  _setCatalog(catalogEntries) {
    this._catalog = Array.isArray(catalogEntries) ? catalogEntries : [];
    this._catalogNameToIndex.clear();
    this._catalogNameSet.clear();
    for (let i = 0; i < this._catalog.length; i++) {
      const name = String(this._catalog[i]?.name || '').toLowerCase();
      if (!name) continue;
      // Keep first occurrence if duplicates exist.
      if (!this._catalogNameToIndex.has(name)) this._catalogNameToIndex.set(name, i);
      this._catalogNameSet.add(name);
    }
  }

  _slotParamKey(base, slot) {
    return `${base}${slot}`;
  }

  _clampOverlayIndex(raw) {
    return Number.isInteger(raw) ? raw : Math.floor(Number(raw) || -1);
  }

  _resolveSlotIndicesWithOverlayRule() {
    const indices = [];
    for (let i = 0; i < OVERLAY_SLOT_COUNT; i++) {
      indices.push(this._clampOverlayIndex(this.params[this._slotParamKey('overlayIndex', i)]));
    }

    let firstLensOverlaySlot = -1;
    for (let i = 0; i < OVERLAY_SLOT_COUNT; i++) {
      const idx = indices[i];
      if (idx < 0 || idx >= this._catalog.length) continue;
      const entry = this._catalog[idx];
      if (entry && isLensOverlayName(entry.name)) {
        if (firstLensOverlaySlot === -1) {
          firstLensOverlaySlot = i;
        } else {
          // Keep lens_overlay_* mutually exclusive while allowing all other textures to stack.
          indices[i] = -1;
        }
      }
    }
    return indices;
  }

  _allOverlaySlotsDisabled() {
    for (let i = 0; i < OVERLAY_SLOT_COUNT; i++) {
      const idx = this._clampOverlayIndex(this.params[this._slotParamKey('overlayIndex', i)]);
      if (idx >= 0) return false;
    }
    return true;
  }

  _findCatalogIndexByName(baseName) {
    if (!baseName) return -1;
    const needle = String(baseName).toLowerCase();
    return this._catalogNameToIndex.get(needle) ?? -1;
  }

  _getAvailableNames(candidates) {
    return uniqueNames(candidates).filter(name => this._catalogNameSet.has(name));
  }

  _normalizeSelection(paramKey, candidates, { allowNone = true, defaultValue = 'auto' } = {}) {
    const allowed = this._getAvailableNames(candidates);
    const raw = String(this.params[paramKey] ?? defaultValue).toLowerCase();
    if (raw === 'auto') {
      this.params[paramKey] = 'auto';
      return;
    }
    if (allowNone && raw === 'none') {
      this.params[paramKey] = 'none';
      return;
    }
    if (allowed.includes(raw)) {
      this.params[paramKey] = raw;
      return;
    }
    this.params[paramKey] = defaultValue;
  }

  _resolveChannelTextureName(selection, candidates, elapsedSeconds, phaseOffset) {
    const available = this._getAvailableNames(candidates);
    if (available.length === 0) return null;

    const mode = String(selection ?? 'auto').toLowerCase();
    if (mode === 'none') return null;
    if (available.includes(mode)) return mode;

    // Auto mode: slowly rotate the active texture to keep subtle variation.
    const cycleSeconds = Math.max(6, Number(this.params.layerCycleSeconds) || 36);
    const elapsed = Number(elapsedSeconds) || 0;
    const phase = Number(phaseOffset) || 0;
    const step = Math.floor((elapsed / cycleSeconds) + phase);
    const idx = ((step % available.length) + available.length) % available.length;
    return available[idx];
  }

  _applyChannelToSlot(slot, config) {
    const {
      name,
      intensity,
      lumaReactivity,
      lumaBoost,
      clearRadius,
      clearSoftness,
      driftX,
      driftY,
      pulseMag,
      pulseFreq,
      pulsePhase,
    } = config;

    const s = String(slot);
    const index = name ? this._findCatalogIndexByName(name) : -1;
    this.params[`overlayIndex${s}`] = index >= 0 ? index : -1;
    this.params[`overlayIntensity${s}`] = Math.max(0, Number(intensity) || 0);
    this.params[`overlayLumaReactivity${s}`] = clamp01(lumaReactivity);
    this.params[`overlayLumaBoost${s}`] = Math.max(0.1, Number(lumaBoost) || 1);
    this.params[`overlayClearRadius${s}`] = Math.max(0, Number(clearRadius) || 0);
    this.params[`overlayClearSoftness${s}`] = Math.max(0.001, Number(clearSoftness) || 0.1);
    this.params[`overlayDriftX${s}`] = Number(driftX) || 0;
    this.params[`overlayDriftY${s}`] = Number(driftY) || 0;
    this.params[`overlayPulseMag${s}`] = Math.max(0, Number(pulseMag) || 0);
    this.params[`overlayPulseFreq${s}`] = Math.max(0, Number(pulseFreq) || 0);
    this.params[`overlayPulsePhase${s}`] = Number(pulsePhase) || 0;
  }

  _configureOverlaySlotsForCurrentFrame(timeInfo) {
    const elapsed = Number(timeInfo?.elapsed) || 0;

    const structuralName = this._resolveChannelTextureName(this.params.structuralSelection, STRUCTURAL_NAMES, elapsed, 0.00);
    const opticalName = this._resolveChannelTextureName(this.params.opticalSelection, OPTICAL_NAMES, elapsed, 0.33);
    const reactiveName = this._resolveChannelTextureName(this.params.reactiveSelection, REACTIVE_NAMES, elapsed, 0.66);
    const viewfinderSelection = this.params.viewfinderEnabled ? this.params.viewfinderSelection : 'none';
    const viewfinderName = this._resolveChannelTextureName(viewfinderSelection, VIEWFINDER_NAMES, elapsed, 0.10);

    this._applyChannelToSlot(0, {
      name: structuralName,
      intensity: this.params.structuralIntensity,
      lumaReactivity: this.params.structuralLumaReactivity,
      lumaBoost: this.params.structuralLumaBoost,
      clearRadius: this.params.structuralClearRadius,
      clearSoftness: this.params.structuralClearSoftness,
      driftX: this.params.structuralDriftX,
      driftY: this.params.structuralDriftY,
      pulseMag: this.params.structuralPulseMag,
      pulseFreq: this.params.structuralPulseFreq,
      pulsePhase: 0.0,
    });

    this._applyChannelToSlot(1, {
      name: opticalName,
      intensity: this.params.opticalIntensity,
      lumaReactivity: this.params.opticalLumaReactivity,
      lumaBoost: this.params.opticalLumaBoost,
      clearRadius: this.params.opticalClearRadius,
      clearSoftness: this.params.opticalClearSoftness,
      driftX: this.params.opticalDriftX,
      driftY: this.params.opticalDriftY,
      pulseMag: this.params.opticalPulseMag,
      pulseFreq: this.params.opticalPulseFreq,
      pulsePhase: 1.9,
    });

    this._applyChannelToSlot(2, {
      name: reactiveName,
      intensity: this.params.reactiveIntensity,
      lumaReactivity: this.params.reactiveLumaReactivity,
      lumaBoost: this.params.reactiveLumaBoost,
      clearRadius: this.params.reactiveClearRadius,
      clearSoftness: this.params.reactiveClearSoftness,
      driftX: this.params.reactiveDriftX,
      driftY: this.params.reactiveDriftY,
      pulseMag: this.params.reactivePulseMag,
      pulseFreq: this.params.reactivePulseFreq,
      pulsePhase: 3.7,
    });

    this._applyChannelToSlot(3, {
      name: viewfinderName,
      intensity: this.params.viewfinderEnabled ? this.params.viewfinderIntensity : 0,
      lumaReactivity: this.params.viewfinderLumaReactivity,
      lumaBoost: this.params.viewfinderLumaBoost,
      clearRadius: this.params.viewfinderClearRadius,
      clearSoftness: this.params.viewfinderClearSoftness,
      driftX: this.params.viewfinderDriftX,
      driftY: this.params.viewfinderDriftY,
      pulseMag: this.params.viewfinderPulseMag,
      pulseFreq: this.params.viewfinderPulseFreq,
      pulsePhase: 0,
    });
  }

  _applyDefaultPresetIfUnset() {
    this._normalizeSelection('structuralSelection', STRUCTURAL_NAMES, { allowNone: true, defaultValue: 'auto' });
    this._normalizeSelection('opticalSelection', OPTICAL_NAMES, { allowNone: true, defaultValue: 'auto' });
    this._normalizeSelection('reactiveSelection', REACTIVE_NAMES, { allowNone: true, defaultValue: 'auto' });
    this._normalizeSelection('viewfinderSelection', VIEWFINDER_NAMES, { allowNone: true, defaultValue: 'none' });
  }

  // ── Control schema ───────────────────────────────────────────────────────────

  static getControlSchema() {
    const viewfinderOptions = makeTextureOptions(VIEWFINDER_NAMES, { includeNone: true, includeAuto: false });
    const structuralOptions = makeTextureOptions(STRUCTURAL_NAMES, { includeNone: true, includeAuto: true });
    const opticalOptions = makeTextureOptions(OPTICAL_NAMES, { includeNone: true, includeAuto: true });
    const reactiveOptions = makeTextureOptions(REACTIVE_NAMES, { includeNone: true, includeAuto: true });

    return {
      enabled: false,
      groups: [
        {
          name: 'lens-dynamics',
          label: 'Dynamic Layer Behavior',
          type: 'folder',
          expanded: true,
          parameters: ['dynamicLayersEnabled', 'layerCycleSeconds', 'lumaSmoothingSeconds', 'layerSwapFadeSeconds']
        },
        {
          name: 'lens-autofocus',
          label: 'Autofocus Defocus Pulses',
          type: 'folder',
          expanded: false,
          parameters: [
            'autoFocusEnabled',
            'autoFocusMinIntervalSeconds', 'autoFocusMaxIntervalSeconds',
            'autoFocusDefocusDurationSeconds', 'autoFocusMaxBlurPx', 'autoFocusMaxShiftPx',
            'autoFocusZoomTriggerEnabled', 'autoFocusZoomTriggerThreshold',
            'autoFocusZoomTriggerCooldownSeconds', 'autoFocusZoomTriggerStrength'
          ]
        },
        {
          name: 'lens-light-burn',
          label: 'Light Burn Persistence',
          type: 'folder',
          expanded: false,
          parameters: [
            'lightBurnEnabled',
            'lightBurnThreshold', 'lightBurnThresholdSoftness',
            'lightBurnPersistenceSeconds', 'lightBurnResponse',
            'lightBurnIntensity', 'lightBurnBlurPx',
            'lightBurnDarknessGateEnabled', 'lightBurnDarknessStart',
            'lightBurnDarknessEnd', 'lightBurnDarknessInfluence'
          ]
        },
        {
          name: 'lens-motion',
          label: 'Camera Motion Response',
          type: 'folder',
          expanded: false,
          parameters: [
            'motionBlurEnabled', 'motionBlurStrength', 'motionBlurMaxPx',
            'motionBlurZoomStrength', 'motionBlurSmoothingSeconds'
          ]
        },
        {
          name: 'lens-viewfinder',
          label: 'Viewfinder Overlay',
          type: 'folder',
          expanded: false,
          parameters: [
            'viewfinderEnabled', 'viewfinderSelection',
            'viewfinderIntensity',
            'viewfinderLumaReactivity', 'viewfinderLumaBoost',
            'viewfinderDriftX', 'viewfinderDriftY',
            'viewfinderPulseMag', 'viewfinderPulseFreq',
          ]
        },
        {
          name: 'lens-structural',
          label: 'Structural Imperfections (Dust / Grease / Scratches)',
          type: 'folder',
          expanded: false,
          parameters: [
            'structuralSelection',
            'structuralIntensity',
            'structuralLumaReactivity', 'structuralLumaBoost',
            'structuralLumaMin', 'structuralLumaMax', 'structuralLumaInfluence',
            'structuralClearRadius', 'structuralClearSoftness',
            'structuralDriftX', 'structuralDriftY',
            'structuralPulseMag', 'structuralPulseFreq',
          ]
        },
        {
          name: 'lens-optical',
          label: 'Optical Artifacts (Lens Leaks / Rings)',
          type: 'folder',
          expanded: false,
          parameters: [
            'opticalSelection',
            'opticalIntensity',
            'opticalLumaReactivity', 'opticalLumaBoost',
            'opticalLumaMin', 'opticalLumaMax', 'opticalLumaInfluence',
            'opticalClearRadius', 'opticalClearSoftness',
            'opticalDriftX', 'opticalDriftY',
            'opticalPulseMag', 'opticalPulseFreq',
          ]
        },
        {
          name: 'lens-reactive',
          label: 'Illumination-Reactive Leaks / Chroma',
          type: 'folder',
          expanded: false,
          parameters: [
            'reactiveSelection',
            'reactiveIntensity',
            'reactiveLumaReactivity', 'reactiveLumaBoost',
            'reactiveLumaMin', 'reactiveLumaMax', 'reactiveLumaInfluence',
            'reactiveClearRadius', 'reactiveClearSoftness',
            'reactiveDriftX', 'reactiveDriftY',
            'reactivePulseMag', 'reactivePulseFreq',
          ]
        },
        {
          name: 'lens-core',
          label: 'Lens Core Distortion / Grading',
          type: 'folder',
          expanded: true,
          parameters: [
            'distortionAmount', 'distortionCenterX', 'distortionCenterY',
            'chromaticAmountPx', 'chromaticEdgePower',
            'vignetteIntensity', 'vignetteSoftness',
            'grainAmount', 'grainSpeed',
            'adaptiveGrainEnabled', 'grainLowLightBoost',
            'grainCellSizeBright', 'grainCellSizeDark',
            'digitalNoiseEnabled', 'digitalNoiseAmount', 'digitalNoiseChance',
            'digitalNoiseGreenBias', 'digitalNoiseLowLightBoost',
          ]
        },
      ],
      parameters: {
        enabled: { type: 'boolean', default: false, hidden: true },

        dynamicLayersEnabled: { type: 'boolean', default: true, label: 'Enable Illumination-Driven Dynamics' },
        layerCycleSeconds: { type: 'slider', min: 8, max: 180, step: 1, default: 36, label: 'Auto Texture Cycle (s)' },
        lumaSmoothingSeconds: { type: 'slider', min: 0.0, max: 3.0, step: 0.05, default: 1, label: 'Light Fade Time (s)' },
        layerSwapFadeSeconds: { type: 'slider', min: 0.0, max: 3.0, step: 0.05, default: 0.8, label: 'Texture Swap Fade (s)' },

        autoFocusEnabled: { type: 'boolean', default: true, label: 'Enable Autofocus Defocus' },
        autoFocusMinIntervalSeconds: { type: 'slider', min: 10, max: 240, step: 1, default: 45, label: 'Min Interval (s)' },
        autoFocusMaxIntervalSeconds: { type: 'slider', min: 10, max: 300, step: 1, default: 130, label: 'Max Interval (s)' },
        autoFocusDefocusDurationSeconds: { type: 'slider', min: 0.05, max: 2.0, step: 0.01, default: 2, label: 'Defocus Duration (s)' },
        autoFocusMaxBlurPx: { type: 'slider', min: 0.0, max: 8.0, step: 0.05, default: 2.75, label: 'Max Blur (px)' },
        autoFocusMaxShiftPx: { type: 'slider', min: 0.0, max: 6.0, step: 0.05, default: 6, label: 'Max Shift (px)' },
        autoFocusZoomTriggerEnabled: { type: 'boolean', default: true, label: 'Zoom Triggers Refocus' },
        autoFocusZoomTriggerThreshold: { type: 'slider', min: 0.05, max: 3.0, step: 0.01, default: 3, label: 'Zoom Trigger Threshold' },
        autoFocusZoomTriggerCooldownSeconds: { type: 'slider', min: 0.0, max: 6.0, step: 0.05, default: 6, label: 'Zoom Trigger Cooldown (s)' },
        autoFocusZoomTriggerStrength: { type: 'slider', min: 0.1, max: 2.5, step: 0.05, default: 0.3, label: 'Zoom Trigger Strength' },

        lightBurnEnabled: { type: 'boolean', default: true, label: 'Enable Light Burn' },
        lightBurnThreshold: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.99, label: 'Bright Threshold' },
        lightBurnThresholdSoftness: { type: 'slider', min: 0.001, max: 0.5, step: 0.005, default: 0.5, label: 'Threshold Softness' },
        lightBurnPersistenceSeconds: { type: 'slider', min: 0.05, max: 8.0, step: 0.05, default: 0.1, label: 'Persistence (s)' },
        lightBurnResponse: { type: 'slider', min: 0.1, max: 3.0, step: 0.05, default: 1.15, label: 'Burn Response' },
        lightBurnIntensity: { type: 'slider', min: 0.0, max: 2.5, step: 0.01, default: 0.15, label: 'Burn Intensity' },
        lightBurnBlurPx: { type: 'slider', min: 0.0, max: 8.0, step: 0.05, default: 8, label: 'Burn Blur (px)' },
        lightBurnDarknessGateEnabled: { type: 'boolean', default: true, label: 'Gate Burn by Scene Darkness' },
        lightBurnDarknessStart: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.45, label: 'Darkness Gate Start' },
        lightBurnDarknessEnd: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.78, label: 'Darkness Gate End' },
        lightBurnDarknessInfluence: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 1.0, label: 'Darkness Gate Influence' },

        motionBlurEnabled: { type: 'boolean', default: false, label: 'Enable Camera Motion Blur' },
        motionBlurStrength: { type: 'slider', min: 0.0, max: 2.0, step: 0.01, default: 1.77, label: 'Motion Blur Strength' },
        motionBlurMaxPx: { type: 'slider', min: 0.0, max: 10.0, step: 0.05, default: 10, label: 'Motion Blur Max (px)' },
        motionBlurZoomStrength: { type: 'slider', min: 0.0, max: 8.0, step: 0.05, default: 1.25, label: 'Zoom Blur Strength' },
        motionBlurSmoothingSeconds: { type: 'slider', min: 0.0, max: 0.8, step: 0.01, default: 0.8, label: 'Motion Blur Smoothing (s)' },

        viewfinderEnabled: { type: 'boolean', default: true, label: 'Enable Viewfinder Overlay' },
        viewfinderSelection: { type: 'string', default: 'none', options: viewfinderOptions, label: 'Viewfinder Texture' },
        viewfinderIntensity: { type: 'slider', min: 0.0, max: 2.0, step: 0.01, default: 0.6 },
        viewfinderLumaReactivity: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.1 },
        viewfinderLumaBoost: { type: 'slider', min: 0.5, max: 4.0, step: 0.05, default: 1.1 },
        viewfinderDriftX: { type: 'slider', min: -0.001, max: 0.001, step: 0.00001, default: 0.0 },
        viewfinderDriftY: { type: 'slider', min: -0.001, max: 0.001, step: 0.00001, default: 0.0 },
        viewfinderPulseMag: { type: 'slider', min: 0.0, max: 0.3, step: 0.01, default: 0.0 },
        viewfinderPulseFreq: { type: 'slider', min: 0.0, max: 2.0, step: 0.01, default: 0.0 },

        structuralSelection: { type: 'string', default: 'auto', options: structuralOptions, label: 'Texture' },
        structuralIntensity: { type: 'slider', min: 0.0, max: 2.0, step: 0.01, default: 0.6 },
        structuralLumaReactivity: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        structuralLumaBoost: { type: 'slider', min: 0.5, max: 4.0, step: 0.05, default: 4 },
        structuralLumaMin: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.00, label: 'Reveal Luma Min' },
        structuralLumaMax: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 1, label: 'Reveal Luma Max' },
        structuralLumaInfluence: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 1, label: 'Reveal Influence' },
        structuralClearRadius: { type: 'slider', min: 0.0, max: 0.5, step: 0.01, default: 0.43 },
        structuralClearSoftness: { type: 'slider', min: 0.01, max: 0.3, step: 0.01, default: 0.10 },
        structuralDriftX: { type: 'slider', min: -0.001, max: 0.001, step: 0.00001, default: 0.00006 },
        structuralDriftY: { type: 'slider', min: -0.001, max: 0.001, step: 0.00001, default: 0.00004 },
        structuralPulseMag: { type: 'slider', min: 0.0, max: 0.3, step: 0.01, default: 0.19 },
        structuralPulseFreq: { type: 'slider', min: 0.0, max: 2.0, step: 0.01, default: 0.08 },

        opticalSelection: { type: 'string', default: 'auto', options: opticalOptions, label: 'Texture' },
        opticalIntensity: { type: 'slider', min: 0.0, max: 2.0, step: 0.01, default: 1.53 },
        opticalLumaReactivity: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        opticalLumaBoost: { type: 'slider', min: 0.5, max: 4.0, step: 0.05, default: 1.15 },
        opticalLumaMin: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0, label: 'Reveal Luma Min' },
        opticalLumaMax: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 1, label: 'Reveal Luma Max' },
        opticalLumaInfluence: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.47, label: 'Reveal Influence' },
        opticalClearRadius: { type: 'slider', min: 0.0, max: 0.5, step: 0.01, default: 0.28 },
        opticalClearSoftness: { type: 'slider', min: 0.01, max: 0.3, step: 0.01, default: 0.12 },
        opticalDriftX: { type: 'slider', min: -0.001, max: 0.001, step: 0.00001, default: 0.00005 },
        opticalDriftY: { type: 'slider', min: -0.001, max: 0.001, step: 0.00001, default: 0.00005 },
        opticalPulseMag: { type: 'slider', min: 0.0, max: 0.3, step: 0.01, default: 0.17 },
        opticalPulseFreq: { type: 'slider', min: 0.0, max: 2.0, step: 0.01, default: 0.11 },

        reactiveSelection: { type: 'string', default: 'light_leak_02', options: reactiveOptions, label: 'Texture' },
        reactiveIntensity: { type: 'slider', min: 0.0, max: 2.0, step: 0.01, default: 0.97 },
        reactiveLumaReactivity: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 1 },
        reactiveLumaBoost: { type: 'slider', min: 0.5, max: 5.0, step: 0.05, default: 1.95 },
        reactiveLumaMin: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0, label: 'Reveal Luma Min' },
        reactiveLumaMax: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 1.00, label: 'Reveal Luma Max' },
        reactiveLumaInfluence: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.53, label: 'Reveal Influence' },
        reactiveClearRadius: { type: 'slider', min: 0.0, max: 0.5, step: 0.01, default: 0.28 },
        reactiveClearSoftness: { type: 'slider', min: 0.01, max: 0.3, step: 0.01, default: 0.14 },
        reactiveDriftX: { type: 'slider', min: -0.001, max: 0.001, step: 0.00001, default: 0.00010 },
        reactiveDriftY: { type: 'slider', min: -0.001, max: 0.001, step: 0.00001, default: 0.00006 },
        reactivePulseMag: { type: 'slider', min: 0.0, max: 0.3, step: 0.01, default: 0.11 },
        reactivePulseFreq: { type: 'slider', min: 0.0, max: 2.0, step: 0.01, default: 0.17 },

        distortionAmount:   { type: 'slider', min: -0.5, max: 0.5,  step: 0.001, default: -0.07 },
        distortionCenterX:  { type: 'slider', min:  0.0, max: 1.0,  step: 0.001, default:  0.5  },
        distortionCenterY:  { type: 'slider', min:  0.0, max: 1.0,  step: 0.001, default:  0.5  },
        chromaticAmountPx:  { type: 'slider', min:  0.0, max: 8.0,  step: 0.01,  default:  4.22  },
        chromaticEdgePower: { type: 'slider', min:  0.1, max: 4.0,  step: 0.01,  default:  2.11  },
        vignetteIntensity:  { type: 'slider', min:  0.0, max: 1.0,  step: 0.01,  default:  1 },
        vignetteSoftness:   { type: 'slider', min: 0.05, max: 1.0,  step: 0.01,  default:  0.34 },
        grainAmount:        { type: 'slider', min:  0.0, max: 0.25, step: 0.001, default:  0.01 },
        grainSpeed:         { type: 'slider', min:  0.0, max: 6.0,  step: 0.01,  default:  1.0  },
        adaptiveGrainEnabled: { type: 'boolean', default: true, label: 'Adaptive Grain (Low-Light)' },
        grainLowLightBoost: { type: 'slider', min: 0.0, max: 3.0, step: 0.01, default: 0.25, label: 'Low-Light Grain Boost' },
        grainCellSizeBright: { type: 'slider', min: 1.0, max: 4.0, step: 0.1, default: 1.4, label: 'Grain Cell Size Bright' },
        grainCellSizeDark: { type: 'slider', min: 1.0, max: 8.0, step: 0.1, default: 3, label: 'Grain Cell Size Dark' },
        digitalNoiseEnabled: { type: 'boolean', default: false, label: 'Enable Digital Chroma Noise' },
        digitalNoiseAmount: { type: 'slider', min: 0.0, max: 0.15, step: 0.001, default: 0.066, label: 'Digital Noise Amount' },
        digitalNoiseChance: { type: 'slider', min: 0.0, max: 0.5, step: 0.001, default: 0.004, label: 'Digital Noise Chance' },
        digitalNoiseGreenBias: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 1, label: 'Digital Noise Green Bias' },
        digitalNoiseLowLightBoost: { type: 'slider', min: 0.0, max: 4.0, step: 0.01, default: 3.37, label: 'Digital Noise Low-Light Boost' },
      }
    };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  initialize() {
    if (this._initialized) return;
    const THREE = window.THREE;
    if (!THREE) return;

    this._loader = new THREE.TextureLoader();

    this._composeScene  = new THREE.Scene();
    this._composeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // 1×1 black fallback used when no overlay is active.
    this._fallbackBlack = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    this._fallbackBlack.needsUpdate = true;

    this._composeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse:    { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uTime:       { value: 0 },
        uSceneLumaOverride: { value: 0.5 },
        uUseSceneLumaOverride: { value: 1.0 },
        uAutoFocusAmount: { value: 0 },
        uAutoFocusBlurPx: { value: 0 },
        uAutoFocusShiftPx: { value: new THREE.Vector2(0, 0) },
        uMotionBlurEnabled: { value: this.params.motionBlurEnabled ? 1.0 : 0.0 },
        uMotionBlurCameraPx: { value: new THREE.Vector2(0, 0) },
        uMotionBlurZoomPx: { value: 0.0 },
        tLightBurnMap: { value: this._fallbackBlack },
        uLightBurnEnabled: { value: 0.0 },
        uLightBurnIntensity: { value: 0.0 },
        uLightBurnBlurPx: { value: 0.0 },

        uDistortionAmount:   { value: this.params.distortionAmount },
        uDistortionCenter:   { value: new THREE.Vector2(0.5, 0.5) },
        uChromaticAmountPx:  { value: this.params.chromaticAmountPx },
        uChromaticEdgePower: { value: this.params.chromaticEdgePower },
        uVignetteIntensity:  { value: this.params.vignetteIntensity },
        uVignetteSoftness:   { value: this.params.vignetteSoftness },
        uGrainAmount:        { value: this.params.grainAmount },
        uGrainSpeed:         { value: this.params.grainSpeed },
        uAdaptiveGrainEnabled: { value: this.params.adaptiveGrainEnabled ? 1.0 : 0.0 },
        uGrainLowLightBoost: { value: this.params.grainLowLightBoost },
        uGrainCellSizeBright: { value: this.params.grainCellSizeBright },
        uGrainCellSizeDark: { value: this.params.grainCellSizeDark },
        uDigitalNoiseEnabled: { value: this.params.digitalNoiseEnabled ? 1.0 : 0.0 },
        uDigitalNoiseAmount: { value: this.params.digitalNoiseAmount },
        uDigitalNoiseChance: { value: this.params.digitalNoiseChance },
        uDigitalNoiseGreenBias: { value: this.params.digitalNoiseGreenBias },
        uDigitalNoiseLowLightBoost: { value: this.params.digitalNoiseLowLightBoost },

        uOverlayTex0:          { value: this._fallbackBlack },
        uOverlayTex1:          { value: this._fallbackBlack },
        uOverlayTex2:          { value: this._fallbackBlack },
        uOverlayTex3:          { value: this._fallbackBlack },
        uOverlayPrevTex0:      { value: this._fallbackBlack },
        uOverlayPrevTex1:      { value: this._fallbackBlack },
        uOverlayPrevTex2:      { value: this._fallbackBlack },
        uOverlayPrevTex3:      { value: this._fallbackBlack },
        uOverlayActive0:       { value: 0.0 },
        uOverlayActive1:       { value: 0.0 },
        uOverlayActive2:       { value: 0.0 },
        uOverlayActive3:       { value: 0.0 },
        uOverlayPrevActive0:   { value: 0.0 },
        uOverlayPrevActive1:   { value: 0.0 },
        uOverlayPrevActive2:   { value: 0.0 },
        uOverlayPrevActive3:   { value: 0.0 },
        uOverlayBlend0:        { value: 1.0 },
        uOverlayBlend1:        { value: 1.0 },
        uOverlayBlend2:        { value: 1.0 },
        uOverlayBlend3:        { value: 1.0 },
        uOverlayScaleOffset0:  { value: new THREE.Vector4(1, 1, 0, 0) },
        uOverlayScaleOffset1:  { value: new THREE.Vector4(1, 1, 0, 0) },
        uOverlayScaleOffset2:  { value: new THREE.Vector4(1, 1, 0, 0) },
        uOverlayScaleOffset3:  { value: new THREE.Vector4(1, 1, 0, 0) },
        uOverlayParams0:       { value: new THREE.Vector4(0.8, 0.35, 1.5, 0.0) },
        uOverlayParams1:       { value: new THREE.Vector4(0.8, 0.35, 1.5, 0.0) },
        uOverlayParams2:       { value: new THREE.Vector4(0.8, 0.35, 1.5, 0.0) },
        uOverlayParams3:       { value: new THREE.Vector4(0.8, 0.35, 1.5, 0.0) },
        uOverlayAnim0:         { value: new THREE.Vector4(0.10, 0.00008, 0.00005, 0.06) },
        uOverlayAnim1:         { value: new THREE.Vector4(0.10, 0.00008, 0.00005, 0.06) },
        uOverlayAnim2:         { value: new THREE.Vector4(0.10, 0.00008, 0.00005, 0.06) },
        uOverlayAnim3:         { value: new THREE.Vector4(0.10, 0.00008, 0.00005, 0.06) },
        uOverlayPulse0:        { value: new THREE.Vector2(0.10, 0.0) },
        uOverlayPulse1:        { value: new THREE.Vector2(0.10, 1.5) },
        uOverlayPulse2:        { value: new THREE.Vector2(0.10, 3.0) },
        uOverlayPulse3:        { value: new THREE.Vector2(0.10, 4.5) },
        uOverlayLumaGate0:     { value: new THREE.Vector4(0.0, 1.0, 0.08, 0.0) },
        uOverlayLumaGate1:     { value: new THREE.Vector4(0.0, 1.0, 0.08, 0.0) },
        uOverlayLumaGate2:     { value: new THREE.Vector4(0.0, 1.0, 0.08, 0.0) },
        uOverlayLumaGate3:     { value: new THREE.Vector4(0.0, 1.0, 0.08, 0.0) },
      },
      vertexShader:   getVertexShader(),
      fragmentShader: getFragmentShader(),
      depthTest:  false,
      depthWrite: false,
      toneMapped: false,
    });

    this._composeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._composeMaterial);
    this._composeQuad.frustumCulled = false;
    this._composeScene.add(this._composeQuad);

    this._initialized = true;

    // Discover catalog async — doesn't block initialization.
    this._discoverCatalog().catch(err => {
      log.warn('LensEffectV2: catalog discovery error:', err);
    });

    this._scheduleNextAutoFocusEvent();

    log.info('LensEffectV2 initialized');
  }

  _randomInRange(min, max) {
    const lo = Number(min) || 0;
    const hi = Number(max) || lo;
    if (hi <= lo) return lo;
    return lo + (Math.random() * (hi - lo));
  }

  _scheduleNextAutoFocusEvent() {
    const minInterval = Math.max(0.5, Number(this.params.autoFocusMinIntervalSeconds) || 45);
    const maxInterval = Math.max(minInterval, Number(this.params.autoFocusMaxIntervalSeconds) || 130);
    this._autoFocusTimeToNextEventSec = this._randomInRange(minInterval, maxInterval);
  }

  _computeAutoFocusAmount(phase) {
    const t = clamp01(phase);
    if (t < 0.55) {
      const x = t / 0.55;
      return x * x * (3 - 2 * x);
    }
    if (t < 0.85) return 1.0;
    const x = clamp01((t - 0.85) / 0.15);
    const smooth = x * x * (3 - 2 * x);
    return 1.0 - smooth;
  }

  _triggerAutoFocusEvent(strength = 1.0) {
    const s = Math.max(0.1, Number(strength) || 1.0);
    this._autoFocusEventActive = true;
    this._autoFocusEventElapsedSec = 0;
    const baseDuration = Math.max(0.05, Number(this.params.autoFocusDefocusDurationSeconds) || 0.35);
    this._autoFocusEventDurationSec = Math.max(0.05, baseDuration / Math.max(0.6, s));
    this._autoFocusAmount = 0;

    const maxShift = Math.max(0, Number(this.params.autoFocusMaxShiftPx) || 0) * Math.min(1.8, s);
    const theta = Math.random() * (Math.PI * 2);
    const mag = maxShift * this._randomInRange(0.45, 1.0);
    this._autoFocusShiftPx.x = Math.cos(theta) * mag;
    this._autoFocusShiftPx.y = Math.sin(theta) * mag;
  }

  _updateAutoFocusState(dtSec) {
    const dt = Math.max(0, Number(dtSec) || 0);
    if (!this.params.autoFocusEnabled) {
      this._autoFocusEventActive = false;
      this._autoFocusAmount = 0;
      this._autoFocusShiftPx.x = 0;
      this._autoFocusShiftPx.y = 0;
      return;
    }

    if (this._autoFocusEventActive) {
      this._autoFocusEventElapsedSec += dt;
      const duration = Math.max(0.05, this._autoFocusEventDurationSec || Number(this.params.autoFocusDefocusDurationSeconds) || 0.35);
      const phase = this._autoFocusEventElapsedSec / duration;
      this._autoFocusAmount = this._computeAutoFocusAmount(phase);
      if (phase >= 1) {
        this._autoFocusEventActive = false;
        this._autoFocusAmount = 0;
        this._autoFocusShiftPx.x = 0;
        this._autoFocusShiftPx.y = 0;
        this._scheduleNextAutoFocusEvent();
      }
      return;
    }

    this._autoFocusTimeToNextEventSec -= dt;
    this._autoFocusZoomCooldownSec = Math.max(0, this._autoFocusZoomCooldownSec - dt);
    if (this._autoFocusTimeToNextEventSec > 0) return;

    this._triggerAutoFocusEvent(1.0);
  }

  _readSceneDarknessLevel() {
    let darkness = 0;
    try {
      darkness = Number(canvas?.environment?.darknessLevel);
    } catch (_) {}
    if (!Number.isFinite(darkness)) {
      try {
        darkness = Number(canvas?.scene?.environment?.darknessLevel);
      } catch (_) {}
    }
    return clamp01(Number.isFinite(darkness) ? darkness : 0);
  }

  _computeLightBurnDarknessGate() {
    if (!this.params.lightBurnDarknessGateEnabled) return 1.0;
    const darkness = this._readSceneDarknessLevel();
    const d0 = clamp01(this.params.lightBurnDarknessStart);
    const d1 = clamp01(this.params.lightBurnDarknessEnd);
    const lo = Math.min(d0, d1);
    const hi = Math.max(d0, d1);
    const denom = Math.max(0.0001, hi - lo);
    const x = clamp01((darkness - lo) / denom);
    const smooth = x * x * (3 - 2 * x);
    return 1.0 + (smooth - 1.0) * clamp01(this.params.lightBurnDarknessInfluence);
  }

  _updateCameraMotionState(dtSec) {
    const dt = Math.max(1 / 240, Number(dtSec) || (1 / 60));
    const frameState = getGlobalFrameState();
    const current = {
      cameraX: Number(frameState?.cameraX) || 0,
      cameraY: Number(frameState?.cameraY) || 0,
      zoom: Number(frameState?.zoom) || 1,
      viewW: Math.max(1e-3, (Number(frameState?.viewMaxX) || 0) - (Number(frameState?.viewMinX) || 0)),
      viewH: Math.max(1e-3, (Number(frameState?.viewMaxY) || 0) - (Number(frameState?.viewMinY) || 0)),
      screenW: Math.max(1, Number(frameState?.screenWidth) || 1),
      screenH: Math.max(1, Number(frameState?.screenHeight) || 1),
    };

    if (!this._lastCameraFrame) {
      this._lastCameraFrame = current;
      this._cameraMotionPx.x = 0;
      this._cameraMotionPx.y = 0;
      this._cameraMotionSmoothedPx.x = 0;
      this._cameraMotionSmoothedPx.y = 0;
      this._cameraMotionBlurPx.x = 0;
      this._cameraMotionBlurPx.y = 0;
      this._zoomMotionBlurPx = 0;
      this._cameraZoomVelocity = 0;
      return;
    }

    const dxWorld = current.cameraX - this._lastCameraFrame.cameraX;
    const dyWorld = current.cameraY - this._lastCameraFrame.cameraY;
    // Camera move right makes world appear to move left, so invert sign.
    this._cameraMotionPx.x = -(dxWorld / current.viewW) * current.screenW;
    this._cameraMotionPx.y = -(dyWorld / current.viewH) * current.screenH;

    const tau = Math.max(0, Number(this.params.motionBlurSmoothingSeconds) || 0);
    const alpha = (tau <= 0.0001) ? 1.0 : (1.0 - Math.exp(-dt / tau));
    this._cameraMotionSmoothedPx.x += (this._cameraMotionPx.x - this._cameraMotionSmoothedPx.x) * alpha;
    this._cameraMotionSmoothedPx.y += (this._cameraMotionPx.y - this._cameraMotionSmoothedPx.y) * alpha;

    const motionStrength = Math.max(0, Number(this.params.motionBlurStrength) || 0);
    const motionMax = Math.max(0, Number(this.params.motionBlurMaxPx) || 0);
    this._cameraMotionBlurPx.x = Math.max(-motionMax, Math.min(motionMax, this._cameraMotionSmoothedPx.x * motionStrength));
    this._cameraMotionBlurPx.y = Math.max(-motionMax, Math.min(motionMax, this._cameraMotionSmoothedPx.y * motionStrength));

    const zoomDelta = current.zoom - this._lastCameraFrame.zoom;
    this._cameraZoomVelocity = zoomDelta / dt;
    const zoomStrength = Math.max(0, Number(this.params.motionBlurZoomStrength) || 0);
    this._zoomMotionBlurPx = Math.max(-motionMax, Math.min(motionMax, this._cameraZoomVelocity * zoomStrength));

    this._lastCameraFrame = current;
  }

  _maybeTriggerZoomRefocus() {
    if (!this.params.autoFocusEnabled || !this.params.autoFocusZoomTriggerEnabled) return;
    if (this._autoFocusEventActive || this._autoFocusZoomCooldownSec > 0) return;
    const speed = Math.abs(Number(this._cameraZoomVelocity) || 0);
    const threshold = Math.max(0.01, Number(this.params.autoFocusZoomTriggerThreshold) || 0.75);
    if (speed < threshold) return;
    const strengthScale = Math.max(0.1, Number(this.params.autoFocusZoomTriggerStrength) || 1.0);
    const strength = Math.min(2.0, strengthScale * (1.0 + (speed - threshold)));
    this._triggerAutoFocusEvent(strength);
    this._autoFocusZoomCooldownSec = Math.max(0, Number(this.params.autoFocusZoomTriggerCooldownSeconds) || 0);
  }

  _disposeLightBurnTargets() {
    if (this._lightBurnReadRT) {
      try { this._lightBurnReadRT.dispose(); } catch (_) {}
      this._lightBurnReadRT = null;
    }
    if (this._lightBurnWriteRT) {
      try { this._lightBurnWriteRT.dispose(); } catch (_) {}
      this._lightBurnWriteRT = null;
    }
    this._lightBurnWidth = 0;
    this._lightBurnHeight = 0;
  }

  _ensureLightBurnResources(width, height) {
    const THREE = window.THREE;
    if (!THREE || !this._fallbackBlack) return false;

    if (!this._lightBurnScene) {
      this._lightBurnScene = new THREE.Scene();
      this._lightBurnCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      this._lightBurnMaterial = new THREE.ShaderMaterial({
        uniforms: {
          tCurrentScene: { value: null },
          tPrevBurn: { value: this._fallbackBlack },
          uThreshold: { value: 0.8 },
          uSoftness: { value: 0.12 },
          uResponse: { value: 1.15 },
          uDecayFactor: { value: 0.98 },
          uBurnWriteGain: { value: 1.0 },
        },
        vertexShader: /* glsl */`
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = vec4(position.xy, 0.0, 1.0);
          }
        `,
        fragmentShader: /* glsl */`
          uniform sampler2D tCurrentScene;
          uniform sampler2D tPrevBurn;
          uniform float uThreshold;
          uniform float uSoftness;
          uniform float uResponse;
          uniform float uDecayFactor;
          uniform float uBurnWriteGain;
          varying vec2 vUv;

          void main() {
            vec3 src = texture2D(tCurrentScene, vUv).rgb;
            vec3 prev = texture2D(tPrevBurn, vUv).rgb * clamp(uDecayFactor, 0.0, 1.0);
            float luma = dot(src, vec3(0.2126, 0.7152, 0.0722));
            float soft = max(0.0001, uSoftness);
            float gate = smoothstep(uThreshold - soft, uThreshold + soft, luma);
            vec3 fresh = src * gate * max(0.0, uResponse) * clamp(uBurnWriteGain, 0.0, 1.0);
            gl_FragColor = vec4(max(prev, fresh), 1.0);
          }
        `,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      });
      this._lightBurnQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._lightBurnMaterial);
      this._lightBurnQuad.frustumCulled = false;
      this._lightBurnScene.add(this._lightBurnQuad);
    }

    const targetW = Math.max(1, Math.floor(Math.max(1, Number(width) || 1) * 0.5));
    const targetH = Math.max(1, Math.floor(Math.max(1, Number(height) || 1) * 0.5));
    if (targetW === this._lightBurnWidth && targetH === this._lightBurnHeight && this._lightBurnReadRT && this._lightBurnWriteRT) {
      return true;
    }

    this._disposeLightBurnTargets();
    this._lightBurnReadRT = new THREE.WebGLRenderTarget(targetW, targetH, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this._lightBurnWriteRT = this._lightBurnReadRT.clone();
    this._lightBurnWidth = targetW;
    this._lightBurnHeight = targetH;
    return true;
  }

  _updateLightBurnMap(renderer, inputRT, dtSec, darknessGate = 1.0) {
    if (!renderer || !inputRT || !this.params.lightBurnEnabled) return;
    if (!this._ensureLightBurnResources(inputRT.width, inputRT.height)) return;
    if (!this._lightBurnMaterial || !this._lightBurnReadRT || !this._lightBurnWriteRT) return;

    const persist = Math.max(0.05, Number(this.params.lightBurnPersistenceSeconds) || 2.5);
    const dt = Math.max(1 / 240, Number(dtSec) || (1 / 60));
    const decay = Math.exp(-dt / persist);

    const u = this._lightBurnMaterial.uniforms;
    u.tCurrentScene.value = inputRT.texture;
    u.tPrevBurn.value = this._lightBurnReadRT.texture;
    u.uThreshold.value = clamp01(this.params.lightBurnThreshold);
    u.uSoftness.value = Math.max(0.001, Number(this.params.lightBurnThresholdSoftness) || 0.12);
    u.uResponse.value = Math.max(0, Number(this.params.lightBurnResponse) || 1.15);
    u.uDecayFactor.value = clamp01(decay);
    u.uBurnWriteGain.value = clamp01(darknessGate);

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.setRenderTarget(this._lightBurnWriteRT);
    renderer.autoClear = true;
    renderer.render(this._lightBurnScene, this._lightBurnCamera);
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);

    const tmp = this._lightBurnReadRT;
    this._lightBurnReadRT = this._lightBurnWriteRT;
    this._lightBurnWriteRT = tmp;
  }

  /**
   * Scans assets/lens assets/ via Foundry FilePicker and populates _catalog.
   * Any image file dropped into that folder is automatically discovered.
   */
  async _discoverCatalog() {
    const discovered = [];
    const browseTargets = [];
    for (const dir of LENS_ASSET_DIR_VARIANTS) {
      browseTargets.push(['public', dir]);
      browseTargets.push(['data', dir]);
      browseTargets.push(['data', dir.replace('modules/map-shine-advanced/', '')]);
    }

    for (const [source, target] of browseTargets) {
      try {
        const result = await FilePicker.browse(source, target);
        const files = result?.files ?? [];
        if (files.length > 0) {
          discovered.push(...files);
          break;
        }
      } catch (_) {
        // Try next source/path variant.
      }
    }

    if (discovered.length > 0) {
      this._setCatalog(makeCatalogFromPaths(discovered));
      this._applyDefaultPresetIfUnset();
      log.info(`LensEffectV2: discovered ${this._catalog.length} overlay(s) in ${LENS_ASSET_DIR}`);
      return;
    }

    const fallbackPaths = FALLBACK_OVERLAY_FILES.map(file => `${LENS_ASSET_DIR}/${file}`);
    this._setCatalog(makeCatalogFromPaths(fallbackPaths));
    this._applyDefaultPresetIfUnset();
    log.warn(`LensEffectV2: FilePicker browse failed or empty; using fallback catalog (${this._catalog.length} entries)`);
  }

  // ── Texture management ───────────────────────────────────────────────────────

  /**
   * Loads the texture for the requested catalog index, disposing the previous
   * one if it has changed. Safe to call every update() frame.
   */
  _syncSlotTexture(slot, wantIndex) {
    if (wantIndex === this._slotLoadedIndices[slot]) return;

    // Begin a soft crossfade from whatever was currently visible in this slot.
    this._beginSlotCrossfade(slot);
    this._slotLoadedIndices[slot] = wantIndex;

    if (this._slotTextures[slot]) this._slotTextures[slot] = null;

    if (wantIndex < 0 || wantIndex >= this._catalog.length) {
      this._applySlotUniforms(slot, null);
      return;
    }

    const entry = this._catalog[wantIndex];
    if (!entry) {
      this._applySlotUniforms(slot, null);
      return;
    }

    const THREE = window.THREE;
    if (!this._loader || !THREE) return;

    const urlCandidates = buildOverlayUrlCandidates(entry.path);
    const tryLoad = (candidateIndex) => {
      if (this._slotLoadedIndices[slot] !== wantIndex) return;
      if (candidateIndex >= urlCandidates.length) {
        log.warn(`LensEffectV2: failed to load overlay for "${entry.name}" from ${urlCandidates.length} URL candidate(s)`);
        this._applySlotUniforms(slot, null);
        return;
      }

      const url = urlCandidates[candidateIndex];
      this._loader.load(
        url,
        (tex) => {
          tex.colorSpace  = THREE.SRGBColorSpace;
          tex.wrapS       = THREE.ClampToEdgeWrapping;
          tex.wrapT       = THREE.ClampToEdgeWrapping;
          tex.minFilter   = THREE.LinearFilter;
          tex.magFilter   = THREE.LinearFilter;
          tex.needsUpdate = true;
          // Guard: index may have changed while async load was in flight.
          if (this._slotLoadedIndices[slot] !== wantIndex) {
            try { tex.dispose(); } catch (_) {}
            return;
          }
          this._slotTextures[slot] = tex;
          this._applySlotUniforms(slot, tex);
          this._updateCoverFit(slot, tex, this._currentScreenW, this._currentScreenH);
          this._applyGroupDefaults(slot, entry.group);
          log.debug(`LensEffectV2: loaded overlay slot ${slot}: "${entry.name}" via ${url}`);
        },
        undefined,
        () => {
          tryLoad(candidateIndex + 1);
        }
      );
    };

    tryLoad(0);
  }

  /** Push overlay texture + active flag into shader uniforms. */
  _applySlotUniforms(slot, tex) {
    if (!this._composeMaterial) return;
    const u = this._composeMaterial.uniforms;
    u[`uOverlayTex${slot}`].value = tex ?? this._fallbackBlack;
    u[`uOverlayActive${slot}`].value = tex ? 1.0 : 0.0;
  }

  _beginSlotCrossfade(slot) {
    if (!this._composeMaterial) return;
    const prevExisting = this._slotPrevTextures[slot];
    if (prevExisting) {
      try { prevExisting.dispose(); } catch (_) {}
      this._slotPrevTextures[slot] = null;
    }

    const outgoing = this._slotTextures[slot];
    const u = this._composeMaterial.uniforms;
    if (outgoing) {
      this._slotPrevTextures[slot] = outgoing;
      u[`uOverlayPrevTex${slot}`].value = outgoing;
      u[`uOverlayPrevActive${slot}`].value = 1.0;
      this._slotBlendT[slot] = 0;
      this._slotBlendDurationSec[slot] = Math.max(0, Number(this.params.layerSwapFadeSeconds) || 0);
      u[`uOverlayBlend${slot}`].value = (this._slotBlendDurationSec[slot] <= 0.0001) ? 1.0 : 0.0;
      return;
    }

    // No previous texture to fade from.
    u[`uOverlayPrevTex${slot}`].value = this._fallbackBlack;
    u[`uOverlayPrevActive${slot}`].value = 0.0;
    this._slotBlendT[slot] = 1;
    this._slotBlendDurationSec[slot] = 0;
    u[`uOverlayBlend${slot}`].value = 1.0;
  }

  _finishSlotCrossfade(slot) {
    const prev = this._slotPrevTextures[slot];
    if (prev) {
      try { prev.dispose(); } catch (_) {}
      this._slotPrevTextures[slot] = null;
    }
    if (!this._composeMaterial) return;
    const u = this._composeMaterial.uniforms;
    u[`uOverlayPrevTex${slot}`].value = this._fallbackBlack;
    u[`uOverlayPrevActive${slot}`].value = 0.0;
    u[`uOverlayBlend${slot}`].value = 1.0;
  }

  _advanceSlotCrossfades(dt) {
    if (!this._composeMaterial) return;
    const u = this._composeMaterial.uniforms;
    const safeDt = Math.max(0, Number(dt) || 0);
    for (let i = 0; i < OVERLAY_SLOT_COUNT; i++) {
      const duration = Math.max(0, Number(this._slotBlendDurationSec[i]) || 0);
      if (duration <= 0.0001 || this._slotBlendT[i] >= 1) {
        if (this._slotBlendT[i] < 1) this._slotBlendT[i] = 1;
        u[`uOverlayBlend${i}`].value = 1.0;
        if (this._slotPrevTextures[i]) this._finishSlotCrossfade(i);
        continue;
      }
      this._slotBlendT[i] = Math.min(1, this._slotBlendT[i] + (safeDt / duration));
      u[`uOverlayBlend${i}`].value = this._slotBlendT[i];
      if (this._slotBlendT[i] >= 1) this._finishSlotCrossfade(i);
    }
  }

  /**
   * Apply group-derived defaults for reactivity/pulse, but only when the user
   * hasn't already changed them from the vanilla defaults. This gives each
   * texture category a sensible initial feel without overriding user tweaks.
   */
  _applyGroupDefaults(slot, grp) {
    if (!grp) return;
    const idx = String(slot);
    // Only apply if params still at their initial default values.
    if (this.params[`overlayLumaReactivity${idx}`] === 0.35) this.params[`overlayLumaReactivity${idx}`] = grp.lumaReactivity;
    if (this.params[`overlayLumaBoost${idx}`]      === 1.50) this.params[`overlayLumaBoost${idx}`]      = grp.lumaBoost;
    if (this.params[`overlayClearRadius${idx}`]    === 0.00) this.params[`overlayClearRadius${idx}`]    = grp.clearRadius;
    if (this.params[`overlayClearSoftness${idx}`]  === 0.10) this.params[`overlayClearSoftness${idx}`]  = grp.clearSoftness;
    if (this.params[`overlayPulseMag${idx}`]       === 0.06) this.params[`overlayPulseMag${idx}`]       = grp.pulseMag;
    if (this.params[`overlayPulseFreq${idx}`]      === 0.10) this.params[`overlayPulseFreq${idx}`]      = grp.pulseFreq;
  }

  /** Recalculate cover-fit UV scale+offset for the active texture. */
  _updateCoverFit(slot, tex, screenW, screenH) {
    if (!this._composeMaterial) return;
    const img = tex?.image;
    const tw  = img?.width  || 0;
    const th  = img?.height || 0;
    const u   = this._composeMaterial.uniforms;
    if (tw > 0 && th > 0) {
      const f = computeCoverScaleOffset(tw, th, screenW, screenH);
      u[`uOverlayScaleOffset${slot}`].value.set(f.sx, f.sy, f.ox, f.oy);
    } else {
      u[`uOverlayScaleOffset${slot}`].value.set(1, 1, 0, 0);
    }
  }

  _sampleSceneLumaFromInputRT(renderer, inputRT) {
    if (!renderer?.readRenderTargetPixels || !inputRT) return null;
    const w = Math.max(1, Number(inputRT.width) || 1);
    const h = Math.max(1, Number(inputRT.height) || 1);
    if (!this._lumaReadPixel) this._lumaReadPixel = new Uint8Array(4);

    const samplePoints = [
      [0.2, 0.2], [0.5, 0.2], [0.8, 0.2],
      [0.2, 0.5], [0.5, 0.5], [0.8, 0.5],
      [0.2, 0.8], [0.5, 0.8], [0.8, 0.8],
    ];

    let sum = 0;
    let count = 0;
    for (const [u, v] of samplePoints) {
      const x = Math.max(0, Math.min(w - 1, Math.floor(u * (w - 1))));
      const y = Math.max(0, Math.min(h - 1, Math.floor(v * (h - 1))));
      try {
        renderer.readRenderTargetPixels(inputRT, x, y, 1, 1, this._lumaReadPixel);
      } catch (_) {
        return null;
      }
      const r = this._lumaReadPixel[0] / 255;
      const g = this._lumaReadPixel[1] / 255;
      const b = this._lumaReadPixel[2] / 255;
      sum += (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
      count++;
    }
    if (count <= 0) return null;
    return clamp01(sum / count);
  }

  _updateSmoothedSceneLuma(renderer, inputRT) {
    const sampled = this._sampleSceneLumaFromInputRT(renderer, inputRT);
    if (!Number.isFinite(sampled)) return;

    const tau = Math.max(0, Number(this.params.lumaSmoothingSeconds) || 0);
    const dt = Math.max(1 / 240, Number(this._lastUpdateDeltaSec) || (1 / 60));
    if (tau <= 0.0001) {
      this._smoothedSceneLuma = sampled;
      // DEBUG: Log raw sampled luma
      if (Math.random() < 0.01) { // 1% sample rate to avoid spam
        log.info(`[LensEffectV2 DEBUG] Raw sampled luma: ${sampled.toFixed(3)}, smoothed: ${this._smoothedSceneLuma.toFixed(3)}`);
      }
      return;
    }

    const alpha = 1 - Math.exp(-dt / tau);
    const prev = Number.isFinite(this._smoothedSceneLuma) ? this._smoothedSceneLuma : sampled;
    this._smoothedSceneLuma = prev + (sampled - prev) * alpha;
    
    // DEBUG: Log smoothed luma periodically
    if (Math.random() < 0.01) { // 1% sample rate to avoid spam
      log.info(`[LensEffectV2 DEBUG] Raw sampled luma: ${sampled.toFixed(3)}, smoothed: ${this._smoothedSceneLuma.toFixed(3)}, tau: ${tau.toFixed(2)}s`);
    }
  }

  // ── Per-frame ────────────────────────────────────────────────────────────────

  update(timeInfo) {
    if (!this._initialized || !this._composeMaterial) return;
    if (!this.params.enabled) return;

    const elapsed = Number(timeInfo?.elapsed);
    if (Number.isFinite(elapsed)) {
      if (Number.isFinite(this._lastUpdateElapsedSec)) {
        const rawDt = elapsed - this._lastUpdateElapsedSec;
        if (rawDt > 0 && rawDt < 1.0) this._lastUpdateDeltaSec = rawDt;
      }
      this._lastUpdateElapsedSec = elapsed;
    }

    this._advanceSlotCrossfades(this._lastUpdateDeltaSec);
    this._updateCameraMotionState(this._lastUpdateDeltaSec);
    this._maybeTriggerZoomRefocus();
    if (this._autoFocusTimeToNextEventSec <= 0) this._scheduleNextAutoFocusEvent();
    this._updateAutoFocusState(this._lastUpdateDeltaSec);
    this._lightBurnDarknessGate = this._computeLightBurnDarknessGate();

    this._configureOverlaySlotsForCurrentFrame(timeInfo);

    const resolvedIndices = this._resolveSlotIndicesWithOverlayRule();
    for (let i = 0; i < OVERLAY_SLOT_COUNT; i++) {
      this._syncSlotTexture(i, resolvedIndices[i]);
    }

    const u = this._composeMaterial.uniforms;
    u.uTime.value = Number(timeInfo?.elapsed) || 0;

    u.uDistortionAmount.value    = Number(this.params.distortionAmount)   || 0;
    u.uDistortionCenter.value.set(clamp01(this.params.distortionCenterX), clamp01(this.params.distortionCenterY));
    u.uChromaticAmountPx.value   = Math.max(0,    Number(this.params.chromaticAmountPx)  || 0);
    u.uChromaticEdgePower.value  = Math.max(0.01, Number(this.params.chromaticEdgePower) || 1);
    u.uVignetteIntensity.value   = clamp01(this.params.vignetteIntensity);
    u.uVignetteSoftness.value    = Math.max(0.01, clamp01(this.params.vignetteSoftness));
    u.uGrainAmount.value         = Math.max(0, Number(this.params.grainAmount) || 0);
    u.uGrainSpeed.value          = Math.max(0, Number(this.params.grainSpeed)  || 0);
    u.uAdaptiveGrainEnabled.value = this.params.adaptiveGrainEnabled ? 1.0 : 0.0;
    u.uGrainLowLightBoost.value = Math.max(0, Number(this.params.grainLowLightBoost) || 0);
    u.uGrainCellSizeBright.value = Math.max(1, Number(this.params.grainCellSizeBright) || 1);
    u.uGrainCellSizeDark.value = Math.max(1, Number(this.params.grainCellSizeDark) || 1);
    u.uDigitalNoiseEnabled.value = this.params.digitalNoiseEnabled ? 1.0 : 0.0;
    u.uDigitalNoiseAmount.value = Math.max(0, Number(this.params.digitalNoiseAmount) || 0);
    u.uDigitalNoiseChance.value = clamp01(this.params.digitalNoiseChance);
    u.uDigitalNoiseGreenBias.value = clamp01(this.params.digitalNoiseGreenBias);
    u.uDigitalNoiseLowLightBoost.value = Math.max(0, Number(this.params.digitalNoiseLowLightBoost) || 0);
    u.uAutoFocusAmount.value     = clamp01(this._autoFocusAmount);
    u.uAutoFocusBlurPx.value     = Math.max(0, Number(this.params.autoFocusMaxBlurPx) || 0);
    u.uAutoFocusShiftPx.value.set(
      Number(this._autoFocusShiftPx?.x) || 0,
      Number(this._autoFocusShiftPx?.y) || 0
    );
    u.uMotionBlurEnabled.value = this.params.motionBlurEnabled ? 1.0 : 0.0;
    u.uMotionBlurCameraPx.value.set(
      Number(this._cameraMotionBlurPx?.x) || 0,
      Number(this._cameraMotionBlurPx?.y) || 0
    );
    u.uMotionBlurZoomPx.value = Number(this._zoomMotionBlurPx) || 0;
    u.uLightBurnEnabled.value    = this.params.lightBurnEnabled ? 1.0 : 0.0;
    u.uLightBurnIntensity.value  = Math.max(0, Number(this.params.lightBurnIntensity) || 0) * clamp01(this._lightBurnDarknessGate);
    u.uLightBurnBlurPx.value     = Math.max(0, Number(this.params.lightBurnBlurPx) || 0);

    for (let i = 0; i < OVERLAY_SLOT_COUNT; i++) {
      const s = String(i);
      u[`uOverlayParams${i}`].value.set(
        Math.max(0, Number(this.params[`overlayIntensity${s}`]) || 0),
        clamp01(this.params[`overlayLumaReactivity${s}`]),
        Math.max(0.1, Number(this.params[`overlayLumaBoost${s}`]) || 1),
        Math.max(0, Number(this.params[`overlayClearRadius${s}`]) || 0)
      );
      u[`uOverlayAnim${i}`].value.set(
        Math.max(0.001, Number(this.params[`overlayClearSoftness${s}`]) || 0.1),
        Number(this.params[`overlayDriftX${s}`]) || 0,
        Number(this.params[`overlayDriftY${s}`]) || 0,
        Math.max(0, Number(this.params[`overlayPulseMag${s}`]) || 0)
      );
      u[`uOverlayPulse${i}`].value.set(
        Math.max(0, Number(this.params[`overlayPulseFreq${s}`]) || 0),
        Number(this.params[`overlayPulsePhase${s}`]) || 0
      );
    }
  }

  render(renderer, camera, inputRT, outputRT, lumaSampleRT = null) {
    if (!this._initialized || !this._composeMaterial || !inputRT) return false;
    if (!this.params.enabled) return false;

    // Let the shader estimate scene luma directly from the input (which includes bloom).
    // The CPU-side override was causing issues because all buffers are darkened by the
    // lighting pass when scene darkness is high. The shader's GPU-side estimation works
    // better because it samples the final image including bloom on bright areas.
    // this._updateSmoothedSceneLuma(renderer, sampleSource);

    if (this.params.lightBurnEnabled) {
      this._updateLightBurnMap(renderer, inputRT, this._lastUpdateDeltaSec, this._lightBurnDarknessGate);
    }

    const w = Math.max(1, Number(inputRT.width)  || 1);
    const h = Math.max(1, Number(inputRT.height) || 1);

    const u = this._composeMaterial.uniforms;
    u.tDiffuse.value = inputRT.texture;
    u.tLightBurnMap.value = this._lightBurnReadRT?.texture ?? this._fallbackBlack;
    u.uResolution.value.set(w, h);
    u.uSceneLumaOverride.value = 0.0;
    u.uUseSceneLumaOverride.value = 0.0;  // Disable CPU override, use GPU estimation

    // Keep cover-fit fresh in case screen size or active texture changed.
    if (w !== this._currentScreenW || h !== this._currentScreenH) {
      this._currentScreenW = w;
      this._currentScreenH = h;
      for (let i = 0; i < OVERLAY_SLOT_COUNT; i++) {
        if (this._slotTextures[i]) {
          this._updateCoverFit(i, this._slotTextures[i], w, h);
        }
      }
    }

    const prevTarget    = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    renderer.setRenderTarget(outputRT);
    renderer.autoClear = true;
    renderer.render(this._composeScene, this._composeCamera);

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);

    return true;
  }

  onResize(width, height) {
    // Cover-fit is recalculated in render() when dimensions change.
    this._disposeLightBurnTargets();
  }

  dispose() {
    for (let i = 0; i < OVERLAY_SLOT_COUNT; i++) {
      if (this._slotTextures[i]) {
        try { this._slotTextures[i].dispose(); } catch (_) {}
        this._slotTextures[i] = null;
      }
      if (this._slotPrevTextures[i]) {
        try { this._slotPrevTextures[i].dispose(); } catch (_) {}
        this._slotPrevTextures[i] = null;
      }
    }
    try { this._composeMaterial?.dispose?.(); } catch (_) {}
    try { this._composeQuad?.geometry?.dispose?.(); } catch (_) {}
    try { this._fallbackBlack?.dispose?.(); } catch (_) {}
    try { this._lightBurnMaterial?.dispose?.(); } catch (_) {}
    try { this._lightBurnQuad?.geometry?.dispose?.(); } catch (_) {}
    this._disposeLightBurnTargets();

    this._composeScene    = null;
    this._composeCamera   = null;
    this._composeMaterial = null;
    this._composeQuad     = null;
    this._fallbackBlack   = null;
    this._lightBurnScene = null;
    this._lightBurnCamera = null;
    this._lightBurnMaterial = null;
    this._lightBurnQuad = null;
    this._loader          = null;
    this._catalog         = [];
    this._catalogNameToIndex.clear();
    this._catalogNameSet.clear();
    this._slotLoadedIndices.fill(-2);
    this._initialized     = false;

    log.info('LensEffectV2 disposed');
  }
}
