/**
 * @fileoverview LensEffectV2 — stylized post-processing lens treatment.
 *
 * Multiple overlay textures can be layered at once across 2 slots.
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
const OVERLAY_SLOT_COUNT = 2;
/** Light-burn RT dimensions are rounded up to this grid to avoid GPU realloc on minor resizes. */
const LIGHT_BURN_RT_ALIGN = 128;
const LIGHT_BURN_RT_SCALE = 0.5;

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
      return { 
        index: i, 
        name, 
        path: String(f), 
        group: groupDefaultsForFile(name),
        isLensOverlay: isLensOverlayName(name)
      };
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

function clamp01(v) { 
  let n = typeof v === 'number' ? v : (Number(v) || 0);
  return n < 0 ? 0 : (n > 1 ? 1 : n);
}

function quantizeDimension(value, align, min = 1) {
  const v = Math.max(min, Math.floor(Number(value) || min));
  const step = Math.max(1, Math.floor(Number(align) || 1));
  return Math.max(min, Math.ceil(v / step) * step);
}

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
     * @type {Array<{index:number, name:string, path:string, group:object, isLensOverlay:boolean}>}
     */
    this._catalog = [];
    /** @type {Map<string, number>} */
    this._catalogNameToIndex = new Map();
    /** @type {Set<string>} */
    this._catalogNameSet = new Set();
    /** @type {Map<Array<string>, Array<string>>} */
    this._availableNamesCache = new Map();

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
    this._lastUpdateElapsedSec = null;
    this._lastUpdateDeltaSec = 1 / 60;
    /** @type {Record<string, number|boolean|Float32Array>} */
    this._uniformCache = {};

    /** Per-slot runtime state — avoids per-frame object/string churn in the hot path. */
    this._overlaySlotIndex = new Int32Array(OVERLAY_SLOT_COUNT).fill(-1);
    this._overlaySlotIntensity = new Float32Array(OVERLAY_SLOT_COUNT).fill(0.8);
    this._overlaySlotLumaReactivity = new Float32Array(OVERLAY_SLOT_COUNT).fill(0.35);
    this._overlaySlotLumaBoost = new Float32Array(OVERLAY_SLOT_COUNT).fill(1.5);
    this._overlaySlotClearRadius = new Float32Array(OVERLAY_SLOT_COUNT).fill(0);
    this._overlaySlotClearSoftness = new Float32Array(OVERLAY_SLOT_COUNT).fill(0.1);
    this._overlaySlotDriftX = new Float32Array(OVERLAY_SLOT_COUNT).fill(0.00008);
    this._overlaySlotDriftY = new Float32Array(OVERLAY_SLOT_COUNT).fill(0.00005);
    this._overlaySlotPulseMag = new Float32Array(OVERLAY_SLOT_COUNT).fill(0.06);
    this._overlaySlotPulseFreq = new Float32Array(OVERLAY_SLOT_COUNT).fill(0.10);
    this._overlaySlotPulsePhase = new Float32Array(OVERLAY_SLOT_COUNT).fill(0);
    
    this._resolvedIndices = new Int32Array(OVERLAY_SLOT_COUNT).fill(-1);

    /** @type {Array<{ tex: object, prevTex: object, active: object, prevActive: object, blend: object, scaleOffset: object, params: object, anim: object, pulse: object }>|null} */
    this._overlayUniformRefs = null;
    this._overlayCacheKeys = [];
    for (let i = 0; i < OVERLAY_SLOT_COUNT; i++) {
      this._overlayCacheKeys.push({
        params: `overlayParams${i}`,
        anim: `overlayAnim${i}`,
        pulse: `overlayPulse${i}`
      });
    }

    this._autoFocusEventActive = false;
    this._autoFocusEventElapsedSec = 0;
    this._autoFocusEventDurationSec = 0.35;
    this._autoFocusTimeToNextEventSec = 60;
    this._autoFocusZoomCooldownSec = 0;
    this._autoFocusShiftPx = { x: 0, y: 0 };
    this._autoFocusAmount = 0;

    this._cameraStateCurrent = null;
    this._cameraStateLast = null;
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

      autoFocusEnabled: false,
      autoFocusMinIntervalSeconds: 10,
      autoFocusMaxIntervalSeconds: 45,
      autoFocusDefocusDurationSeconds: 2,
      autoFocusMaxBlurPx: 2.5,
      autoFocusMaxShiftPx: 6,
      autoFocusZoomTriggerEnabled: true,
      autoFocusZoomTriggerThreshold: 3,
      autoFocusZoomTriggerCooldownSeconds: 6,
      autoFocusZoomTriggerStrength: 0.15,

      lightBurnEnabled: false,
      lightBurnThreshold: 0.98,
      lightBurnThresholdSoftness: 0.5,
      lightBurnPersistenceSeconds: 0.05,
      lightBurnResponse: 1.15,
      lightBurnIntensity: 0.1,
      lightBurnBlurPx: 8,
      lightBurnDarknessGateEnabled: true,
      lightBurnDarknessStart: 0,
      lightBurnDarknessEnd: 1,
      lightBurnDarknessInfluence: 0.5,

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
      reactiveIntensity: 1.63,
      reactiveLumaReactivity: 1,
      reactiveLumaBoost: 1.95,
      reactiveLumaMin: 0,
      reactiveLumaMax: 1,
      reactiveLumaInfluence: 0.53,
      reactiveClearRadius: 0.5,
      reactiveClearSoftness: 0.3,
      reactiveDriftX: 0,
      reactiveDriftY: 0.00006,
      reactivePulseMag: 0.03,
      reactivePulseFreq: 0.01,

      viewfinderEnabled: true,
      viewfinderSelection: 'none',
      viewfinderIntensity: 0.6,
      viewfinderLumaReactivity: 0.1,
      viewfinderLumaBoost: 1.1,
      viewfinderDriftX: 0.0,
      viewfinderDriftY: 0.0,
      viewfinderPulseMag: 0.0,
      viewfinderPulseFreq: 0.0,

      // Overlay slots: -1 = disabled, otherwise catalog index (runtime state in _overlaySlot* arrays).
      overlayIndex0: -1,
      overlayIndex1: -1,

      // Per-slot tuning (legacy flat keys — migrated to _overlaySlot* at runtime).
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

      // Core lens controls.
      distortionAmount:   -0.08,
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
    this._availableNamesCache.clear();
    for (let i = 0; i < this._catalog.length; i++) {
      const name = String(this._catalog[i]?.name || '').toLowerCase();
      if (!name) continue;
      // Keep first occurrence if duplicates exist.
      if (!this._catalogNameToIndex.has(name)) this._catalogNameToIndex.set(name, i);
      this._catalogNameSet.add(name);
    }
  }

  _setScalarUniform(uniform, cacheKey, value) {
    if (this._uniformCache[cacheKey] === value) return;
    this._uniformCache[cacheKey] = value;
    uniform.value = value;
  }

  _setVec2Uniform(uniform, cacheKey, x, y) {
    let prev = this._uniformCache[cacheKey];
    if (prev && prev[0] === x && prev[1] === y) return;
    if (!prev) prev = this._uniformCache[cacheKey] = new Float32Array(2);
    prev[0] = x;
    prev[1] = y;
    uniform.value.set(x, y);
  }

  _setVec4Uniform(uniform, cacheKey, x, y, z, w) {
    let prev = this._uniformCache[cacheKey];
    if (prev && prev[0] === x && prev[1] === y && prev[2] === z && prev[3] === w) return;
    if (!prev) prev = this._uniformCache[cacheKey] = new Float32Array(4);
    prev[0] = x;
    prev[1] = y;
    prev[2] = z;
    prev[3] = w;
    uniform.value.set(x, y, z, w);
  }

  _clampOverlayIndex(raw) {
    return Number.isInteger(raw) ? raw : Math.floor(Number(raw) || -1);
  }

  _resolveSlotIndicesWithOverlayRule() {
    const indices = this._resolvedIndices;
    for (let i = 0; i < OVERLAY_SLOT_COUNT; i++) {
      let raw = this._overlaySlotIndex[i];
      indices[i] = Number.isInteger(raw) ? raw : Math.floor(raw || -1);
    }

    let firstLensOverlaySlot = -1;
    for (let i = 0; i < OVERLAY_SLOT_COUNT; i++) {
      const idx = indices[i];
      if (idx < 0 || idx >= this._catalog.length) continue;
      const entry = this._catalog[idx];
      if (entry && entry.isLensOverlay) {
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
      if (this._overlaySlotIndex[i] >= 0) return false;
    }
    return true;
  }

  _findCatalogIndexByName(baseName) {
    if (!baseName) return -1;
    let idx = this._catalogNameToIndex.get(baseName);
    if (idx !== undefined) return idx;
    const needle = String(baseName).toLowerCase();
    return this._catalogNameToIndex.get(needle) ?? -1;
  }

  _getAvailableNames(candidates) {
    let cached = this._availableNamesCache.get(candidates);
    if (!cached) {
      cached = uniqueNames(candidates).filter(name => this._catalogNameSet.has(name));
      this._availableNamesCache.set(candidates, cached);
    }
    return cached;
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

    let mode = selection;
    if (mode === 'none' || mode === 'None' || !mode) return null;
    
    let isAvailable = false;
    if (typeof mode === 'string') {
      for (let i = 0; i < available.length; i++) {
        if (available[i] === mode) {
          isAvailable = true;
          break;
        }
      }
    }
    
    if (!isAvailable && mode !== 'auto' && mode !== 'Auto') {
      mode = String(selection ?? 'auto').toLowerCase();
      if (mode === 'none') return null;
      isAvailable = available.includes(mode);
    }

    if (isAvailable) return mode;

    // Auto mode: slowly rotate the active texture to keep subtle variation.
    const cycleSeconds = (this.params.layerCycleSeconds > 6) ? this.params.layerCycleSeconds : 6;
    const elapsed = elapsedSeconds || 0;
    const phase = phaseOffset || 0;
    const step = Math.floor((elapsed / cycleSeconds) + phase);
    const idx = ((step % available.length) + available.length) % available.length;
    return available[idx];
  }

  _applyChannelToSlot(
    slot,
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
    pulsePhase
  ) {
    const index = name ? this._findCatalogIndexByName(name) : -1;
    this._overlaySlotIndex[slot] = index >= 0 ? index : -1;
    this._overlaySlotIntensity[slot] = intensity > 0 ? intensity : 0;
    this._overlaySlotLumaReactivity[slot] = lumaReactivity < 0 ? 0 : (lumaReactivity > 1 ? 1 : (lumaReactivity || 0));
    this._overlaySlotLumaBoost[slot] = lumaBoost > 0.1 ? lumaBoost : 0.1;
    this._overlaySlotClearRadius[slot] = clearRadius > 0 ? clearRadius : 0;
    this._overlaySlotClearSoftness[slot] = clearSoftness > 0.001 ? clearSoftness : 0.001;
    this._overlaySlotDriftX[slot] = driftX || 0;
    this._overlaySlotDriftY[slot] = driftY || 0;
    this._overlaySlotPulseMag[slot] = pulseMag > 0 ? pulseMag : 0;
    this._overlaySlotPulseFreq[slot] = pulseFreq > 0 ? pulseFreq : 0;
    this._overlaySlotPulsePhase[slot] = pulsePhase || 0;
  }

  _configureOverlaySlotsForCurrentFrame(timeInfo) {
    const elapsed = timeInfo ? (Number(timeInfo.elapsed) || 0) : 0;

    const structuralName = this._resolveChannelTextureName(this.params.structuralSelection, STRUCTURAL_NAMES, elapsed, 0.00);
    const opticalName = this._resolveChannelTextureName(this.params.opticalSelection, OPTICAL_NAMES, elapsed, 0.33);
    const reactiveName = this._resolveChannelTextureName(this.params.reactiveSelection, REACTIVE_NAMES, elapsed, 0.66);
    const viewfinderSelection = this.params.viewfinderEnabled ? this.params.viewfinderSelection : 'none';
    const viewfinderName = this._resolveChannelTextureName(viewfinderSelection, VIEWFINDER_NAMES, elapsed, 0.10);

    this._applyChannelToSlot(
      0,
      structuralName,
      this.params.structuralIntensity,
      this.params.structuralLumaReactivity,
      this.params.structuralLumaBoost,
      this.params.structuralClearRadius,
      this.params.structuralClearSoftness,
      this.params.structuralDriftX,
      this.params.structuralDriftY,
      this.params.structuralPulseMag,
      this.params.structuralPulseFreq,
      0.0
    );

    // Slot 1: viewfinder takes priority; otherwise alternate optical / reactive each cycle.
    const viewfinderActive = this.params.viewfinderEnabled
      && String(this.params.viewfinderSelection ?? 'none').toLowerCase() !== 'none'
      && viewfinderName;
    if (viewfinderActive) {
      this._applyChannelToSlot(
        1,
        viewfinderName,
        this.params.viewfinderIntensity,
        this.params.viewfinderLumaReactivity,
        this.params.viewfinderLumaBoost,
        0,
        0.10,
        this.params.viewfinderDriftX,
        this.params.viewfinderDriftY,
        this.params.viewfinderPulseMag,
        this.params.viewfinderPulseFreq,
        0
      );
    } else {
      const cycleSeconds = (this.params.layerCycleSeconds > 6) ? this.params.layerCycleSeconds : 6;
      const useOptical = (Math.floor(elapsed / cycleSeconds) % 2) === 0;
      if (useOptical) {
        this._applyChannelToSlot(
          1,
          opticalName,
          this.params.opticalIntensity,
          this.params.opticalLumaReactivity,
          this.params.opticalLumaBoost,
          this.params.opticalClearRadius,
          this.params.opticalClearSoftness,
          this.params.opticalDriftX,
          this.params.opticalDriftY,
          this.params.opticalPulseMag,
          this.params.opticalPulseFreq,
          1.9
        );
      } else {
        this._applyChannelToSlot(
          1,
          reactiveName,
          this.params.reactiveIntensity,
          this.params.reactiveLumaReactivity,
          this.params.reactiveLumaBoost,
          this.params.reactiveClearRadius,
          this.params.reactiveClearSoftness,
          this.params.reactiveDriftX,
          this.params.reactiveDriftY,
          this.params.reactivePulseMag,
          this.params.reactivePulseFreq,
          3.7
        );
      }
    }
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
          name: 'lens-autofocus-motion',
          label: 'Autofocus & motion',
          type: 'folder',
          expanded: true,
          subgroups: [
            {
              label: 'Motion blur',
              parameters: [
                'motionBlurEnabled', 'motionBlurStrength', 'motionBlurMaxPx',
                'motionBlurZoomStrength', 'motionBlurSmoothingSeconds'
              ]
            },
            {
              label: 'Autofocus',
              advanced: true,
              parameters: [
                'autoFocusEnabled',
                'autoFocusMinIntervalSeconds', 'autoFocusMaxIntervalSeconds',
                'autoFocusDefocusDurationSeconds', 'autoFocusMaxBlurPx', 'autoFocusMaxShiftPx',
                'autoFocusZoomTriggerEnabled', 'autoFocusZoomTriggerThreshold',
                'autoFocusZoomTriggerCooldownSeconds', 'autoFocusZoomTriggerStrength'
              ]
            },
            {
              label: 'Light burn',
              advanced: true,
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
              label: 'Dynamic layers',
              advanced: true,
              parameters: ['dynamicLayersEnabled', 'layerCycleSeconds', 'lumaSmoothingSeconds', 'layerSwapFadeSeconds']
            }
          ]
        },
        {
          name: 'lens-overlays',
          label: 'Overlays',
          type: 'folder',
          expanded: false,
          subgroups: [
            {
              label: 'Viewfinder',
              advanced: true,
              parameters: [
                'viewfinderEnabled', 'viewfinderSelection',
                'viewfinderIntensity',
                'viewfinderLumaReactivity', 'viewfinderLumaBoost',
                'viewfinderDriftX', 'viewfinderDriftY',
                'viewfinderPulseMag', 'viewfinderPulseFreq',
              ]
            },
            {
              label: 'Dust & scratches',
              advanced: true,
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
              label: 'Leaks & chroma',
              advanced: true,
              parameters: [
                'opticalSelection',
                'opticalIntensity',
                'opticalLumaReactivity', 'opticalLumaBoost',
                'opticalLumaMin', 'opticalLumaMax', 'opticalLumaInfluence',
                'opticalClearRadius', 'opticalClearSoftness',
                'opticalDriftX', 'opticalDriftY',
                'opticalPulseMag', 'opticalPulseFreq',
                'reactiveSelection',
                'reactiveIntensity',
                'reactiveLumaReactivity', 'reactiveLumaBoost',
                'reactiveLumaMin', 'reactiveLumaMax', 'reactiveLumaInfluence',
                'reactiveClearRadius', 'reactiveClearSoftness',
                'reactiveDriftX', 'reactiveDriftY',
                'reactivePulseMag', 'reactivePulseFreq',
              ]
            }
          ]
        },
        {
          name: 'lens-core',
          label: 'Optical distortions',
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
        lightBurnBlurPx: { type: 'slider', min: 0.0, max: 8.0, step: 0.05, default: 5, label: 'Burn Blur (px)' },
        lightBurnDarknessGateEnabled: { type: 'boolean', default: true, label: 'Gate Burn by Scene Darkness' },
        lightBurnDarknessStart: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.45, label: 'Darkness Gate Start' },
        lightBurnDarknessEnd: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.78, label: 'Darkness Gate End' },
        lightBurnDarknessInfluence: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 1.0, label: 'Darkness Gate Influence' },

        motionBlurEnabled: { type: 'boolean', default: false, label: 'Enable Camera Motion Blur' },
        motionBlurStrength: { type: 'slider', min: 0.0, max: 2.0, step: 0.01, default: 1.77, label: 'Motion Blur Strength' },
        motionBlurMaxPx: { type: 'slider', min: 0.0, max: 10.0, step: 0.05, default: 5, label: 'Motion Blur Max (px)' },
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

    this._lightBurnScene = new THREE.Scene();
    this._lightBurnScene.name = 'LensLightBurnScene';
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
        uOverlayPrevTex0:      { value: this._fallbackBlack },
        uOverlayPrevTex1:      { value: this._fallbackBlack },
        uOverlayActive0:       { value: 0.0 },
        uOverlayActive1:       { value: 0.0 },
        uOverlayPrevActive0:   { value: 0.0 },
        uOverlayPrevActive1:   { value: 0.0 },
        uOverlayBlend0:        { value: 1.0 },
        uOverlayBlend1:        { value: 1.0 },
        uOverlayScaleOffset0:  { value: new THREE.Vector4(1, 1, 0, 0) },
        uOverlayScaleOffset1:  { value: new THREE.Vector4(1, 1, 0, 0) },
        uOverlayParams0:       { value: new THREE.Vector4(0.8, 0.35, 1.5, 0.0) },
        uOverlayParams1:       { value: new THREE.Vector4(0.8, 0.35, 1.5, 0.0) },
        uOverlayAnim0:         { value: new THREE.Vector4(0.10, 0.00008, 0.00005, 0.06) },
        uOverlayAnim1:         { value: new THREE.Vector4(0.10, 0.00008, 0.00005, 0.06) },
        uOverlayPulse0:        { value: new THREE.Vector2(0.10, 0.0) },
        uOverlayPulse1:        { value: new THREE.Vector2(0.10, 1.5) },
        uOverlayLumaGate0:     { value: new THREE.Vector4(0.0, 1.0, 0.08, 0.0) },
        uOverlayLumaGate1:     { value: new THREE.Vector4(0.0, 1.0, 0.08, 0.0) },
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

    const u = this._composeMaterial.uniforms;
    this._overlayUniformRefs = [];
    for (let i = 0; i < OVERLAY_SLOT_COUNT; i++) {
      this._overlayUniformRefs.push({
        tex: u[`uOverlayTex${i}`],
        prevTex: u[`uOverlayPrevTex${i}`],
        active: u[`uOverlayActive${i}`],
        prevActive: u[`uOverlayPrevActive${i}`],
        blend: u[`uOverlayBlend${i}`],
        scaleOffset: u[`uOverlayScaleOffset${i}`],
        params: u[`uOverlayParams${i}`],
        anim: u[`uOverlayAnim${i}`],
        pulse: u[`uOverlayPulse${i}`],
      });
    }

    this._initialized = true;

    // Discover catalog async — doesn't block initialization.
    this._discoverCatalog().catch(err => {
      log.warn('LensEffectV2: catalog discovery error:', err);
    });

    this._scheduleNextAutoFocusEvent();

    log.info('LensEffectV2 initialized');
  }

  getCompileTargets() {
    return [
      { scene: this._composeScene, camera: this._composeCamera },
      { scene: this._lightBurnScene, camera: this._lightBurnCamera },
    ];
  }

  _randomInRange(min, max) {
    const lo = Number(min) || 0;
    const hi = Number(max) || lo;
    if (hi <= lo) return lo;
    return lo + (Math.random() * (hi - lo));
  }

  _scheduleNextAutoFocusEvent() {
    const minInterval = this.params.autoFocusMinIntervalSeconds > 0.5 ? this.params.autoFocusMinIntervalSeconds : 0.5;
    const maxInterval = this.params.autoFocusMaxIntervalSeconds > minInterval ? this.params.autoFocusMaxIntervalSeconds : minInterval;
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
    const s = strength > 0.1 ? strength : 0.1;
    this._autoFocusEventActive = true;
    this._autoFocusEventElapsedSec = 0;
    const baseDuration = this.params.autoFocusDefocusDurationSeconds > 0.05 ? this.params.autoFocusDefocusDurationSeconds : 0.35;
    const computedDuration = baseDuration / (s > 0.6 ? s : 0.6);
    this._autoFocusEventDurationSec = computedDuration > 0.05 ? computedDuration : 0.05;
    this._autoFocusAmount = 0;

    const maxShift = (this.params.autoFocusMaxShiftPx > 0 ? this.params.autoFocusMaxShiftPx : 0) * (s < 1.8 ? s : 1.8);
    const theta = Math.random() * (Math.PI * 2);
    const mag = maxShift * this._randomInRange(0.45, 1.0);
    this._autoFocusShiftPx.x = Math.cos(theta) * mag;
    this._autoFocusShiftPx.y = Math.sin(theta) * mag;
  }

  _updateAutoFocusState(dtSec) {
    const dt = dtSec > 0 ? dtSec : 0;
    if (!this.params.autoFocusEnabled) {
      this._autoFocusEventActive = false;
      this._autoFocusAmount = 0;
      this._autoFocusShiftPx.x = 0;
      this._autoFocusShiftPx.y = 0;
      return;
    }

    if (this._autoFocusEventActive) {
      this._autoFocusEventElapsedSec += dt;
      const paramDur = this.params.autoFocusDefocusDurationSeconds;
      const duration = this._autoFocusEventDurationSec > 0.05 ? this._autoFocusEventDurationSec : (paramDur > 0.05 ? paramDur : 0.35);
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
    this._autoFocusZoomCooldownSec = this._autoFocusZoomCooldownSec - dt;
    if (this._autoFocusZoomCooldownSec < 0) this._autoFocusZoomCooldownSec = 0;

    if (this._autoFocusTimeToNextEventSec > 0) return;

    this._triggerAutoFocusEvent(1.0);
  }

  _readSceneDarknessLevel() {
    let darkness = 0;
    if (typeof canvas !== 'undefined' && canvas !== null) {
      if (canvas.environment && typeof canvas.environment.darknessLevel === 'number') {
        darkness = canvas.environment.darknessLevel;
      } else if (canvas.scene && canvas.scene.environment && typeof canvas.scene.environment.darknessLevel === 'number') {
        darkness = canvas.scene.environment.darknessLevel;
      }
    }
    return clamp01(darkness);
  }

  _computeLightBurnDarknessGate() {
    if (!this.params.lightBurnDarknessGateEnabled) return 1.0;
    const darkness = this._readSceneDarknessLevel();
    const d0 = clamp01(this.params.lightBurnDarknessStart);
    const d1 = clamp01(this.params.lightBurnDarknessEnd);
    const lo = d0 < d1 ? d0 : d1;
    const hi = d0 > d1 ? d0 : d1;
    const denom = hi - lo;
    if (denom < 0.0001) {
      return darkness >= lo ? (1.0 + (1.0 - 1.0) * clamp01(this.params.lightBurnDarknessInfluence)) : 1.0;
    }
    const rawX = (darkness - lo) / denom;
    const x = rawX < 0 ? 0 : (rawX > 1 ? 1 : rawX);
    const smooth = x * x * (3 - 2 * x);
    return 1.0 + (smooth - 1.0) * clamp01(this.params.lightBurnDarknessInfluence);
  }

  _updateCameraMotionState(dtSec) {
    const dt = dtSec > 0.004166 ? dtSec : 0.004166;
    const frameState = getGlobalFrameState();

    if (!this._cameraStateCurrent) {
      this._cameraStateCurrent = { cameraX: 0, cameraY: 0, zoom: 1, viewW: 1, viewH: 1, screenW: 1, screenH: 1 };
      this._cameraStateLast = { cameraX: 0, cameraY: 0, zoom: 1, viewW: 1, viewH: 1, screenW: 1, screenH: 1 };
      this._lastCameraFrame = null;
    }
    
    const curr = this._cameraStateCurrent;
    curr.cameraX = frameState ? (frameState.cameraX || 0) : 0;
    curr.cameraY = frameState ? (frameState.cameraY || 0) : 0;
    curr.zoom    = frameState ? (frameState.zoom || 1) : 1;
    curr.viewW   = Math.max(1e-3, frameState ? ((frameState.viewMaxX || 0) - (frameState.viewMinX || 0)) : 1);
    curr.viewH   = Math.max(1e-3, frameState ? ((frameState.viewMaxY || 0) - (frameState.viewMinY || 0)) : 1);
    curr.screenW = Math.max(1, frameState ? (frameState.screenWidth || 1) : 1);
    curr.screenH = Math.max(1, frameState ? (frameState.screenHeight || 1) : 1);

    if (!this._lastCameraFrame) {
      Object.assign(this._cameraStateLast, curr);
      this._lastCameraFrame = this._cameraStateLast;
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

    const dxWorld = curr.cameraX - this._cameraStateLast.cameraX;
    const dyWorld = curr.cameraY - this._cameraStateLast.cameraY;
    
    // Camera move right makes world appear to move left, so invert sign.
    this._cameraMotionPx.x = -(dxWorld / curr.viewW) * curr.screenW;
    this._cameraMotionPx.y = -(dyWorld / curr.viewH) * curr.screenH;

    const tau = this.params.motionBlurSmoothingSeconds > 0 ? this.params.motionBlurSmoothingSeconds : 0;
    const alpha = (tau <= 0.0001) ? 1.0 : (1.0 - Math.exp(-dt / tau));
    this._cameraMotionSmoothedPx.x += (this._cameraMotionPx.x - this._cameraMotionSmoothedPx.x) * alpha;
    this._cameraMotionSmoothedPx.y += (this._cameraMotionPx.y - this._cameraMotionSmoothedPx.y) * alpha;

    const motionStrength = this.params.motionBlurStrength > 0 ? this.params.motionBlurStrength : 0;
    const motionMax = this.params.motionBlurMaxPx > 0 ? this.params.motionBlurMaxPx : 0;
    
    let xBlur = this._cameraMotionSmoothedPx.x * motionStrength;
    let yBlur = this._cameraMotionSmoothedPx.y * motionStrength;
    this._cameraMotionBlurPx.x = xBlur < -motionMax ? -motionMax : (xBlur > motionMax ? motionMax : xBlur);
    this._cameraMotionBlurPx.y = yBlur < -motionMax ? -motionMax : (yBlur > motionMax ? motionMax : yBlur);

    const zoomDelta = curr.zoom - this._cameraStateLast.zoom;
    this._cameraZoomVelocity = zoomDelta / dt;
    const zoomStrength = this.params.motionBlurZoomStrength > 0 ? this.params.motionBlurZoomStrength : 0;
    
    let zBlur = this._cameraZoomVelocity * zoomStrength;
    this._zoomMotionBlurPx = zBlur < -motionMax ? -motionMax : (zBlur > motionMax ? motionMax : zBlur);

    this._cameraStateLast.cameraX = curr.cameraX;
    this._cameraStateLast.cameraY = curr.cameraY;
    this._cameraStateLast.zoom = curr.zoom;
    this._cameraStateLast.viewW = curr.viewW;
    this._cameraStateLast.viewH = curr.viewH;
    this._cameraStateLast.screenW = curr.screenW;
    this._cameraStateLast.screenH = curr.screenH;
  }

  _maybeTriggerZoomRefocus() {
    if (!this.params.autoFocusEnabled || !this.params.autoFocusZoomTriggerEnabled) return;
    if (this._autoFocusEventActive || this._autoFocusZoomCooldownSec > 0) return;
    const speed = Math.abs(this._cameraZoomVelocity || 0);
    const threshold = this.params.autoFocusZoomTriggerThreshold > 0.01 ? this.params.autoFocusZoomTriggerThreshold : 0.75;
    if (speed < threshold) return;
    const strengthScale = this.params.autoFocusZoomTriggerStrength > 0.1 ? this.params.autoFocusZoomTriggerStrength : 1.0;
    const strength = Math.min(2.0, strengthScale * (1.0 + (speed - threshold)));
    this._triggerAutoFocusEvent(strength);
    this._autoFocusZoomCooldownSec = this.params.autoFocusZoomTriggerCooldownSeconds > 0 ? this.params.autoFocusZoomTriggerCooldownSeconds : 0;
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
    if (!THREE || !this._fallbackBlack || !this._lightBurnScene) return false;

    const targetW = quantizeDimension(Math.floor(Math.max(1, Number(width) || 1) * LIGHT_BURN_RT_SCALE), LIGHT_BURN_RT_ALIGN);
    const targetH = quantizeDimension(Math.floor(Math.max(1, Number(height) || 1) * LIGHT_BURN_RT_SCALE), LIGHT_BURN_RT_ALIGN);
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

    const persist = this.params.lightBurnPersistenceSeconds > 0.05 ? this.params.lightBurnPersistenceSeconds : 2.5;
    const dt = dtSec > 0.004166 ? dtSec : 0.004166;
    const decay = Math.exp(-dt / persist);

    const u = this._lightBurnMaterial.uniforms;
    u.tCurrentScene.value = inputRT.texture;
    u.tPrevBurn.value = this._lightBurnReadRT.texture;
    u.uThreshold.value = clamp01(this.params.lightBurnThreshold);
    u.uSoftness.value = this.params.lightBurnThresholdSoftness > 0.001 ? this.params.lightBurnThresholdSoftness : 0.12;
    u.uResponse.value = this.params.lightBurnResponse > 0 ? this.params.lightBurnResponse : 1.15;
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

          try {
            const renderer = window.MapShine?.renderLoop?.renderer || window.MapShine?.scene?.renderer;
            if (renderer && typeof renderer.initTexture === 'function') {
              renderer.initTexture(tex);
            }
          } catch (_) {}

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
    const refs = this._overlayUniformRefs?.[slot];
    if (!refs) return;
    refs.tex.value = tex ?? this._fallbackBlack;
    refs.active.value = tex ? 1.0 : 0.0;
  }

  _beginSlotCrossfade(slot) {
    const refs = this._overlayUniformRefs?.[slot];
    if (!refs) return;
    const prevExisting = this._slotPrevTextures[slot];
    if (prevExisting) {
      try { prevExisting.dispose(); } catch (_) {}
      this._slotPrevTextures[slot] = null;
    }

    const outgoing = this._slotTextures[slot];
    if (outgoing) {
      this._slotPrevTextures[slot] = outgoing;
      refs.prevTex.value = outgoing;
      refs.prevActive.value = 1.0;
      this._slotBlendT[slot] = 0;
      this._slotBlendDurationSec[slot] = this.params.layerSwapFadeSeconds > 0 ? this.params.layerSwapFadeSeconds : 0;
      refs.blend.value = (this._slotBlendDurationSec[slot] <= 0.0001) ? 1.0 : 0.0;
      return;
    }

    // No previous texture to fade from.
    refs.prevTex.value = this._fallbackBlack;
    refs.prevActive.value = 0.0;
    this._slotBlendT[slot] = 1;
    this._slotBlendDurationSec[slot] = 0;
    refs.blend.value = 1.0;
  }

  _finishSlotCrossfade(slot) {
    const prev = this._slotPrevTextures[slot];
    if (prev) {
      try { prev.dispose(); } catch (_) {}
      this._slotPrevTextures[slot] = null;
    }
    const refs = this._overlayUniformRefs?.[slot];
    if (!refs) return;
    refs.prevTex.value = this._fallbackBlack;
    refs.prevActive.value = 0.0;
    refs.blend.value = 1.0;
  }

  _advanceSlotCrossfades(dt) {
    const safeDt = dt > 0 ? dt : 0;
    for (let i = 0; i < OVERLAY_SLOT_COUNT; i++) {
      const refs = this._overlayUniformRefs?.[i];
      if (!refs) continue;
      const duration = this._slotBlendDurationSec[i] > 0 ? this._slotBlendDurationSec[i] : 0;
      if (duration <= 0.0001 || this._slotBlendT[i] >= 1) {
        if (this._slotBlendT[i] < 1) this._slotBlendT[i] = 1;
        if (refs.blend.value !== 1.0) refs.blend.value = 1.0;
        if (this._slotPrevTextures[i]) this._finishSlotCrossfade(i);
        continue;
      }
      this._slotBlendT[i] += safeDt / duration;
      if (this._slotBlendT[i] > 1) this._slotBlendT[i] = 1;
      refs.blend.value = this._slotBlendT[i];
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
    // Only apply if slot params still at their initial default values.
    if (this._overlaySlotLumaReactivity[slot] === 0.35) this._overlaySlotLumaReactivity[slot] = grp.lumaReactivity;
    if (this._overlaySlotLumaBoost[slot]      === 1.50) this._overlaySlotLumaBoost[slot]      = grp.lumaBoost;
    if (this._overlaySlotClearRadius[slot]    === 0.00) this._overlaySlotClearRadius[slot]    = grp.clearRadius;
    if (this._overlaySlotClearSoftness[slot]  === 0.10) this._overlaySlotClearSoftness[slot]  = grp.clearSoftness;
    if (this._overlaySlotPulseMag[slot]       === 0.06) this._overlaySlotPulseMag[slot]       = grp.pulseMag;
    if (this._overlaySlotPulseFreq[slot]      === 0.10) this._overlaySlotPulseFreq[slot]      = grp.pulseFreq;
  }

  /** Recalculate cover-fit UV scale+offset for the active texture. */
  _updateCoverFit(slot, tex, screenW, screenH) {
    const refs = this._overlayUniformRefs?.[slot];
    if (!refs) return;
    const img = tex?.image;
    const tw  = img?.width  || 0;
    const th  = img?.height || 0;
    if (tw > 0 && th > 0) {
      const f = computeCoverScaleOffset(tw, th, screenW, screenH);
      refs.scaleOffset.value.set(f.sx, f.sy, f.ox, f.oy);
    } else {
      refs.scaleOffset.value.set(1, 1, 0, 0);
    }
  }

  // ── Per-frame ────────────────────────────────────────────────────────────────

  update(timeInfo) {
    if (!this._initialized || !this._composeMaterial) return;
    if (!this.params.enabled) return;

    const elapsed = timeInfo && timeInfo.elapsed ? timeInfo.elapsed : 0;
    if (typeof elapsed === 'number' && Number.isFinite(elapsed)) {
      if (this._lastUpdateElapsedSec !== null) {
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
    u.uTime.value = elapsed;

    this._setScalarUniform(u.uDistortionAmount, 'distortionAmount', this.params.distortionAmount || 0);
    this._setVec2Uniform(
      u.uDistortionCenter,
      'distortionCenter',
      clamp01(this.params.distortionCenterX),
      clamp01(this.params.distortionCenterY)
    );
    this._setScalarUniform(u.uChromaticAmountPx, 'chromaticAmountPx', this.params.chromaticAmountPx > 0 ? this.params.chromaticAmountPx : 0);
    this._setScalarUniform(u.uChromaticEdgePower, 'chromaticEdgePower', this.params.chromaticEdgePower > 0.01 ? this.params.chromaticEdgePower : 1);
    this._setScalarUniform(u.uVignetteIntensity, 'vignetteIntensity', clamp01(this.params.vignetteIntensity));
    this._setScalarUniform(u.uVignetteSoftness, 'vignetteSoftness', Math.max(0.01, clamp01(this.params.vignetteSoftness)));
    this._setScalarUniform(u.uGrainAmount, 'grainAmount', this.params.grainAmount > 0 ? this.params.grainAmount : 0);
    this._setScalarUniform(u.uGrainSpeed, 'grainSpeed', this.params.grainSpeed > 0 ? this.params.grainSpeed : 0);
    this._setScalarUniform(u.uAdaptiveGrainEnabled, 'adaptiveGrainEnabled', this.params.adaptiveGrainEnabled ? 1.0 : 0.0);
    this._setScalarUniform(u.uGrainLowLightBoost, 'grainLowLightBoost', this.params.grainLowLightBoost > 0 ? this.params.grainLowLightBoost : 0);
    this._setScalarUniform(u.uGrainCellSizeBright, 'grainCellSizeBright', this.params.grainCellSizeBright > 1 ? this.params.grainCellSizeBright : 1);
    this._setScalarUniform(u.uGrainCellSizeDark, 'grainCellSizeDark', this.params.grainCellSizeDark > 1 ? this.params.grainCellSizeDark : 1);
    this._setScalarUniform(u.uDigitalNoiseEnabled, 'digitalNoiseEnabled', this.params.digitalNoiseEnabled ? 1.0 : 0.0);
    this._setScalarUniform(u.uDigitalNoiseAmount, 'digitalNoiseAmount', this.params.digitalNoiseAmount > 0 ? this.params.digitalNoiseAmount : 0);
    this._setScalarUniform(u.uDigitalNoiseChance, 'digitalNoiseChance', clamp01(this.params.digitalNoiseChance));
    this._setScalarUniform(u.uDigitalNoiseGreenBias, 'digitalNoiseGreenBias', clamp01(this.params.digitalNoiseGreenBias));
    this._setScalarUniform(u.uDigitalNoiseLowLightBoost, 'digitalNoiseLowLightBoost', this.params.digitalNoiseLowLightBoost > 0 ? this.params.digitalNoiseLowLightBoost : 0);

    this._setScalarUniform(u.uAutoFocusAmount, 'autoFocusAmount', clamp01(this._autoFocusAmount));
    this._setScalarUniform(u.uAutoFocusBlurPx, 'autoFocusBlurPx', this.params.autoFocusMaxBlurPx > 0 ? this.params.autoFocusMaxBlurPx : 0);
    this._setVec2Uniform(
      u.uAutoFocusShiftPx,
      'autoFocusShiftPx',
      this._autoFocusShiftPx.x || 0,
      this._autoFocusShiftPx.y || 0
    );
    this._setScalarUniform(u.uMotionBlurEnabled, 'motionBlurEnabled', this.params.motionBlurEnabled ? 1.0 : 0.0);
    this._setVec2Uniform(
      u.uMotionBlurCameraPx,
      'motionBlurCameraPx',
      this._cameraMotionBlurPx.x || 0,
      this._cameraMotionBlurPx.y || 0
    );
    this._setScalarUniform(u.uMotionBlurZoomPx, 'motionBlurZoomPx', this._zoomMotionBlurPx || 0);
    this._setScalarUniform(u.uLightBurnEnabled, 'lightBurnEnabled', this.params.lightBurnEnabled ? 1.0 : 0.0);
    this._setScalarUniform(u.uLightBurnIntensity, 'lightBurnIntensity', (this.params.lightBurnIntensity > 0 ? this.params.lightBurnIntensity : 0) * clamp01(this._lightBurnDarknessGate));
    this._setScalarUniform(u.uLightBurnBlurPx, 'lightBurnBlurPx', this.params.lightBurnBlurPx > 0 ? this.params.lightBurnBlurPx : 0);

    for (let i = 0; i < OVERLAY_SLOT_COUNT; i++) {
      const refs = this._overlayUniformRefs?.[i];
      if (!refs) continue;
      
      const keys = this._overlayCacheKeys[i];

      this._setVec4Uniform(
        refs.params,
        keys.params,
        this._overlaySlotIntensity[i],
        this._overlaySlotLumaReactivity[i],
        this._overlaySlotLumaBoost[i],
        this._overlaySlotClearRadius[i]
      );
      this._setVec4Uniform(
        refs.anim,
        keys.anim,
        this._overlaySlotClearSoftness[i] > 0.001 ? this._overlaySlotClearSoftness[i] : 0.1,
        this._overlaySlotDriftX[i],
        this._overlaySlotDriftY[i],
        this._overlaySlotPulseMag[i] > 0 ? this._overlaySlotPulseMag[i] : 0
      );
      this._setVec2Uniform(
        refs.pulse,
        keys.pulse,
        this._overlaySlotPulseFreq[i] > 0 ? this._overlaySlotPulseFreq[i] : 0,
        this._overlaySlotPulsePhase[i] || 0
      );
    }
  }

  render(renderer, camera, inputRT, outputRT, lumaSampleRT = null) {
    if (!this._initialized || !this._composeMaterial || !inputRT) return false;
    if (!this.params.enabled) return false;

    if (this.params.lightBurnEnabled) {
      this._updateLightBurnMap(renderer, inputRT, this._lastUpdateDeltaSec, this._lightBurnDarknessGate);
    }

    const w = inputRT.width > 0 ? inputRT.width : 1;
    const h = inputRT.height > 0 ? inputRT.height : 1;

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
    // Light-burn RTs are resized lazily via quantized _ensureLightBurnResources().
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
    this._availableNamesCache.clear();
    this._slotLoadedIndices.fill(-2);
    this._overlayUniformRefs = null;
    this._uniformCache = {};
    this._initialized     = false;

    log.info('LensEffectV2 disposed');
  }
}