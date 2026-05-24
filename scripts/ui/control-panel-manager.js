/**
 * @fileoverview Control Panel Manager - GM live-play interface
 * Tactile native UI for time-of-day and weather control during actual play
 * @module ui/control-panel-manager
 */
import {
  createControlPanelShell,
  createSection,
  createCpButton,
  createFadeTimeSlider,
  createSegmentedControl,
  createNativeControl,
  createStepperControl,
  formatFadeMinutes,
  openAdvancedDrawer,
  triggerPanelClunk,
} from './control-panel/cp-shell.js';
import { createFaderBoard, mirrorFaderRow, clearAllFaderPreviews, setFaderPreview, setFaderLiveValue } from './control-panel/widgets/fader-board.js';
import {
  createAstrolabeDial,
  CONTEXT_HINT_IDLE,
  GUSTINESS_LABELS,
  GUSTINESS_DISPLAY,
} from './control-panel/widgets/astrolabe-dial.js';
import { createDynamicWeatherDeck } from './control-panel/widgets/dynamic-weather-deck.js';
import { lookupBiome } from './control-panel/widgets/dynamic-weather-catalog.js';
import { updatePhaseRing } from './control-panel/widgets/smart-ring-clock.js';
import { canPersistSceneDocument, isGmLike } from '../core/gm-parity.js';


import { createLogger } from '../core/log.js';
import { stateApplier } from './state-applier.js';
import { weatherController as coreWeatherController } from '../core/WeatherController.js';
import {
  applyDirectedCustomPresetToWeather,
  resolveWeatherController,
  hydrateControlPanelLiveOverridesFromController,
  LIVE_WEATHER_OVERRIDE_PARAM_IDS
} from './weather-param-bridge.js';
import { LIVE_WEATHER_PANEL_SPECS } from './environment-override-specs.js';
import {
  applyAshMasterIntensity,
  isAnyAshSystemEnabledInScene,
  readAshIntensityFromController,
} from './ash-weather-bridge.js';
import { environmentControlApi } from './environment-control-api.js';
import {
  environmentFadeController,
  snapshotFromControlState,
  fadeExtrasFromControlState,
  gustinessFromExtras,
} from './environment-fade-controller.js';
import { debugLoadingProfiler } from '../core/debug-loading-profiler.js';
import { getFoundryTimePhaseHours } from '../core/foundry-time-phases.js';
import {
  resolveTodQuickPickAnchors,
  readColorCorrectionParamsFromUi,
  todHourToOrbitAngleDeg,
} from '../core/tod-anchor-spec.js';
import { extendMsaLocalFlagWriteGuard, refreshMsaSameSceneRedrawPredict } from '../utils/msa-local-flag-guard.js';
import { cloneAndSanitizeControlState, inferWeatherPanelView, sanitizeControlStateInPlace } from '../settings/control-state-sanitize.js';
import { getWeatherSyncBridge } from '../foundry/weather-sync-bridge.js';
import {
  readLightningIntensityFromControlState,
  syncWeatherLightningEffectFromControlState,
  triggerLandscapeLightningAction,
  writeLightningIntensityToControlState,
} from './landscape-lightning-bridge.js';
import {
  readManualFogDensityFromControlState,
  syncAtmosphericFogEffectFromControlState,
  syncControlStateFromAtmosphericFogEffect,
  writeManualFogDensityToControlState,
} from './atmospheric-fog-bridge.js';
import {
  createDefaultPlayerLightAllowance,
  getGlobalPlayerLightModeAllowed,
  resolvePlayerLightModeAllowance
} from '../core/player-light-allowance.js';

const log = createLogger('ControlPanel');

/** Control panel outer width (wand remote). */
const CP_PANEL_WIDTH_PX = 436;

/** Horizontal arc offset (px outward) — peaks at mid-column to hug the dial. */
const WEATHER_FINGER_ARC_OFFSETS = Object.freeze([6, 14, 22, 28, 22, 14, 6]);
const WEATHER_FINGER_H_PX = 22;
const WEATHER_FINGER_GAP_PX = 2;
const WEATHER_FINGER_STAGE_H_PX = 300;

/** Weather preset lozenges flanking the astrolabe dial. */
const WEATHER_FINGER_PRESETS = Object.freeze({
  left: [
    { id: 'Clear (Dry)', icon: '☀️', label: 'Clear' },
    { id: 'Clear (Breezy)', icon: '🌬', label: 'Breezy' },
    { id: 'Partly Cloudy', icon: '⛅', label: 'Partly' },
    { id: 'Overcast (Light)', icon: '☁', label: 'Overcast' },
    { id: 'Mist', icon: '🌫', label: 'Mist' },
    { id: 'Drizzle', icon: '🌦', label: 'Drizzle' },
    { id: 'Light Rain', icon: '🌧', label: 'Light' },
  ],
  right: [
    { id: 'Rain', icon: '🌧', label: 'Rain' },
    { id: 'Heavy Rain', icon: '🌧', label: 'Heavy' },
    { id: 'Thunderstorm', icon: '⛈', label: 'Storm' },
    { id: 'Snow Flurries', icon: '🌨', label: 'Flurries' },
    { id: 'Snow', icon: '❄', label: 'Snow' },
    { id: 'Blizzard', icon: '🌨', label: 'Blizzard' },
    { id: 'Fog (Dense)', icon: '🌫', label: 'Fog' },
  ],
});

/** GM panel "Gustiness" → WeatherController.variability (wind surge / meander strength). */
const GUSTINESS_TO_VARIABILITY = Object.freeze({
  calm: 0.25,
  light: 0.45,
  moderate: 0.7,
  strong: 0.85,
  extreme: 0.95
});

const MAX_WIND_MS_CP = 78.0;

/**
 * Manages the GM Control Panel with time-of-day clock and weather controls
 * Optimized for live play - fast, concise, authoritative
 */
export class ControlPanelManager {
  constructor() {
    /** @type {{ zones: Record<string, HTMLElement>, statusLed: HTMLElement }|null} */
    this._shell = null;
    
    /** @type {HTMLElement|null} */
    this.container = null;
    
    /** @type {boolean} Whether panel is visible */
    this.visible = false;

    if (this._statusIntervalId) {
      clearInterval(this._statusIntervalId);
      this._statusIntervalId = null;
    }
    
    /** @type {HTMLElement|null} Custom clock DOM element */
    this.clockElement = null;
    
    /** @type {boolean} Whether user is currently dragging clock hand */
    this.isDraggingClock = false;

    /** @type {number|null} */
    this._dragTimeTarget = null;

    /** @type {number|null} Hour at pointer-down when dragging the clock (fade transitions). */
    this._dragTimeStartHour = null;

    /** @type {import('./environment-control-api.js').EnvironmentSnapshot|null} */
    this._environmentFadePreviewStartSnap = null;

    /** @type {import('./environment-fade-controller.js').FadeExtras|null} */
    this._environmentFadePreviewStartExtras = null;

    /** @type {{ speedMS?: number, directionDeg?: number }|null} */
    this._pendingWindTarget = null;

    /** @type {boolean} */
    this._environmentFadeTransitionActive = false;

    /** @type {Set<string>} */
    this._fadeChannelDragActive = new Set();

    /** @type {number|null} */
    this._lastTimeTargetApplied = null;

    /** @type {number|null} */
    this._lastTimeTransitionMinutesApplied = null;

    /** @type {boolean} */
    this._didRevealTimeTarget = false;
    
    /** @type {Object} Runtime control state (saved to scene flags) */
    this.controlState = {
      timeOfDay: 12.0,
      timeTransitionMinutes: 0.0,
      linkTimeToFoundry: false,
      weatherMode: 'dynamic', // 'dynamic' | 'directed'
      /** Manual Weather sliders vs Weather Director in the unified Weather folder. */
      weatherPanelView: 'manual', // 'manual' | 'directed' | 'dynamic' (legacy 'director' migrated)
      // Dynamic mode
      dynamicEnabled: false,
      dynamicPresetId: 'Temperate Plains',
      /** Scene mood / biome card in Dynamic deck (`mood:…` or `biome:…`). */
      dynamicEnvironmentPresetId: null,
      dynamicEvolutionSpeed: 60.0,
      dynamicPaused: false,
      // Directed mode
      directedPresetId: 'Clear (Dry)',
      directedTransitionMinutes: 5.0,
      directedCustomPreset: {
        precipitation: 0.0,
        cloudCover: 0.15,
        windSpeed: 39.0 / 78.0,
        windDirection: 180.0,
        fogDensity: 0.0,
        freezeLevel: 0.0
      },
      // Wind controls
      // Real-world wind speed in m/s (0..MAX_WIND_MS). WeatherController will still expose
      // a derived legacy 0..1 `windSpeed` for existing effects.
      windSpeedMS: 39.0,
      windDirection: 180.0,
      gustiness: 'moderate', // 'calm', 'light', 'moderate', 'strong', 'extreme'
      // Tile motion transport controls (runtime state still lives in tileMotion scene flag)
      tileMotionSpeedPercent: 100,
      tileMotionAutoPlayEnabled: true,
      tileMotionTimeFactorPercent: 100,
      tileMotionPaused: false,
      playerLightAllowance: createDefaultPlayerLightAllowance(),
      replicaOcclusionRadiusScale: 35.0,
      replicaOcclusionEdgeSoftness: 1.0,
      landscapeLightning: {
        lightning: 1.0,
      },
      manualFogDensity: 0.0,
    };

    this._suppressInitialWeatherApply = false;

    /**
     * Stable object reference for `directedCustomPreset` merge (flags / scene sync).
     * Live overrides UI is plain DOM; this still keeps one canonical preset object.
     * @type {Object|null}
     */
    this._rapidWeatherBindingTarget = this.controlState.directedCustomPreset;

    /** True once Manual Weather DOM rows are built (idempotent). */
    this._liveWeatherOverrideDomBuilt = false;

    /** @type {ReturnType<typeof createAstrolabeDial>|null} */
    this._astrolabe = null;

    /** @type {Record<string, HTMLElement>|null} Section tag elements */
    this._sectionTags = null;

    /** @type {HTMLElement|null} Manual Weather DOM container */
    this._weatherManualViewEl = null;

    /** @type {HTMLElement|null} Weather Director DOM container */
    this._weatherDirectorViewEl = null;

    /** @type {{ manualBtn: HTMLButtonElement, directorBtn: HTMLButtonElement }|null} */
    this._weatherViewToggleButtons = null;

    /**
     * Plain DOM for the five scalars (avoids Tweakpane number-binding NaN issues).
     * @type {{ root: HTMLElement, rows: Record<string, { range: HTMLInputElement, number: HTMLInputElement }> }|null}
     */
    this._liveWeatherOverrideDom = null;

    /** Skip DOM-driven commits while programmatically syncing range/number from preset. */
    this._suppressLiveWeatherDomEvents = false;
    
    /** @type {Object} Cached DOM elements for clock */
    this.clockElements = {};

    /** @type {HTMLElement|null} */
    this._windArrow = null;

    /** @type {HTMLElement|null} */
    this._windStrengthBarInner = null;

    /** @type {HTMLElement|null} */
    this._windStrengthText = null;

    /** @type {{ timeRate: number }|null} */
    this._timeScaleParams = null;

    /** @type {{ mirror: ()=>void }|null} */
    this._timeScaleControl = null;

    /** @type {Record<string, { mirror: ()=>void }>} */
    this._nativeControls = {};
    
    /** @type {Function} Debounced save function */
    this.debouncedSave = this._debounce(() => this._saveControlState(), 500);

    /** @type {HTMLElement|null} */
    this.statusPanel = null;

    /** @type {HTMLElement|null} */
    this.headerOverlay = null;

    /** Plain DOM for overhead occlusion sliders (Tweakpane number blades do not drag reliably here). */
    this._replicaOcclDomBuilt = false;

    /** @type {{ root: HTMLElement, rangeR: HTMLInputElement, numR: HTMLInputElement, rangeE: HTMLInputElement, numE: HTMLInputElement }|null} */
    this._replicaOcclDom = null;

    /** Skip replica-occlusion DOM handlers while mirroring from `controlState`. */
    this._suppressReplicaOcclDom = false;

    /** @type {HTMLInputElement|null} Custom time transition input (replaces Tweakpane binding) */
    this._timeTransitionInput = null;

    /** @type {HTMLInputElement|null} Custom link-to-Foundry checkbox */
    this._timeLinkCheckbox = null;

    /** @type {HTMLButtonElement|null} */
    this._minimizeButton = null;

    /** @type {HTMLElement|null} */
    this._minimizedDock = null;

    /** @type {HTMLButtonElement|null} */
    this._minimizedOpenBtn = null;

    /** @type {HTMLElement|null} */
    this._minimizedHandle = null;

    /** @type {boolean} */
    this._isMinimized = false;

    /** @type {boolean} */
    this._isDraggingMinimizedDock = false;

    /** @type {{mx:number,my:number,left:number,top:number}|null} */
    this._minimizedDragStart = null;

    /** @type {string} */
    this._uiStateStorageKey = 'map-shine-advanced.control-panel-ui-v1';

    /** @type {boolean} */
    this._isDraggingPanel = false;

    /** @type {{mx:number,my:number,left:number,top:number}|null} */
    this._dragStart = null;

    /** @type {number|null} */
    this._statusIntervalId = null;

    /** @type {number|null} */
    this._sunLatitudeSyncIntervalId = null;

    /** @type {number|null} */
    this._worldTimeHookId = null;

    /** @type {boolean} */
    this._isApplyingFoundryTimeSync = false;

    /** @type {{sunLatitude:number}} */
    this._environmentState = {
      sunLatitude: 0.1
    };

    /** @type {any|null} */
    this._sunLatitudeBinding = null;

    /** @type {any|null} */
    this._tileMotionSpeedBinding = null;

    /** @type {HTMLElement|null} */
    this._tileMotionStripTag = null;

    /** @type {HTMLElement|null} Shared contextual hint under the dial. */
    this._contextHintEl = null;

    /** @type {Map<string, string>} */
    this._contextHintSources = new Map();

    /** @type {any|null} */
    this._weatherDirectedFolder = null;

    /** @type {boolean} */
    this._singleOpenTopLevelSections = false;

    /** @type {Array<{ id: string, setExpanded: (v: boolean)=>void }>} */
    this._sections = [];

    /** @type {Object<string, HTMLElement|null>} */
    this._folderTags = {
      master: null,
      quick: null,
      time: null,
      weather: null,
      wind: null,
      environment: null,
      utilities: null,
      system: null
    };

    /** @type {boolean} */
    this._didLoadControlState = false;

    /**
     * Last serialized weather-relevant control state applied via _applyRapidWeatherOverrides.
     * When only time-of-day changes, we must NOT re-apply directed Custom scalars — that was
     * overwriting WeatherController (and persisted weather-snapshot) with stale zeros from
     * directedCustomPreset every clock tick.
     * @type {string|null}
     */
    this._lastWeatherControlFingerprint = null;

    /**
     * One-shot guard: skip next Scene `controlState` flag persist when save came
     * from live weather sliders. Frequent same-scene flag writes can trigger V14
     * redraw/tearDown cycles that look like full scene reloads.
     * @type {boolean}
     */
    this._skipNextControlStateSceneFlagPersist = false;
    /**
     * When true, skipped persist should still push one Foundry darkness sync.
     * Used for time-only updates (clock/quick-time) so we avoid scene flag writes
     * while still applying darkness after scrubbing.
     * @type {boolean}
     */
    this._syncDarknessOnSkippedPersist = false;

    this._boundHandlers = {
      onFaceMouseDown: (e) => this._onClockMouseDown(e),
      onFaceTouchStart: (e) => this._onClockTouchStart(e),
      onDocMouseMove: (e) => this._onClockMouseMove(e),
      onDocMouseUp: () => this._onClockMouseUp(),
      onDocTouchMove: (e) => this._onClockTouchMove(e),
      onDocTouchEnd: () => this._onClockMouseUp(),
      onHeaderMouseDown: (e) => this._onHeaderMouseDown(e),
      onDocPanelMouseMove: (e) => this._onHeaderMouseMove(e),
      onDocPanelMouseUp: () => this._onHeaderMouseUp(),
      onMinimizeButtonClick: (e) => this._onMinimizeButtonClick(e),
      onMinimizedOpenClick: (e) => this._onMinimizedOpenClick(e),
      onMinimizedHandlePointerDown: (e) => this._onMinimizedHandlePointerDown(e),
      onMinimizedDockPointerMove: (e) => this._onMinimizedDockPointerMove(e),
      onMinimizedDockPointerUp: (e) => this._onMinimizedDockPointerUp(e)
    };
  }

  _getQuickTimeAnchors() {
    const phases = getFoundryTimePhaseHours();
    return {
      Dawn: Number.isFinite(phases?.dawn) ? phases.dawn : 6.0,
      Noon: Number.isFinite(phases?.noon) ? phases.noon : 12.0,
      Dusk: Number.isFinite(phases?.dusk) ? phases.dusk : 18.0,
      Midnight: Number.isFinite(phases?.midnight) ? phases.midnight : 0.0
    };
  }

  _registerSection(sectionRec) {
    if (!sectionRec) return;
    this._sections.push(sectionRec);
  }

  _ensureSectionTag(section, key, initialText = '') {
    if (!section?.tag) return null;
    if (!this._sectionTags) this._sectionTags = {};
    this._sectionTags[key] = section.tag;
    this._setFolderTag(key, initialText);
    return section.tag;
  }

  _registerTopLevelFolder(_folder) {
    /* legacy no-op — native sections use _registerSection */
  }

  _ensureFolderTag(folder, key, initialText = '') {
    try {
      const titleElement = folder?.element?.querySelector?.('.tp-fldv_t')
        || folder?.header
        || folder?.querySelector?.('.msa-cp-section__header');
      if (!titleElement) return null;

      let tag = titleElement.querySelector(`.map-shine-folder-tag-${key}`);
      if (!tag) {
        tag = document.createElement('span');
        tag.className = `map-shine-folder-tag map-shine-folder-tag-${key} msa-cp-section__tag`;
        titleElement.appendChild(tag);
      }

      if (!this._sectionTags) this._sectionTags = {};
      this._folderTags[key] = tag;
      this._sectionTags[key] = tag;
      this._setFolderTag(key, initialText);
      return tag;
    } catch (_) {
      return null;
    }
  }

  async _setTileMotionPaused(paused, options = undefined) {
    try {
      const mgr = window.MapShine?.tileMotionManager;
      if (!mgr || typeof mgr.setPaused !== 'function') return false;
      return await mgr.setPaused(paused === true, options);
    } catch (error) {
      log.warn('Failed to set tile motion pause state:', error);
      return false;
    }
  }

  _setFolderTag(key, text) {
    const tag = this._sectionTags?.[key] || this._folderTags?.[key];
    if (!tag) return;
    const next = String(text || '').trim();
    tag.textContent = next;
    tag.style.display = next ? 'inline-flex' : 'none';
  }

  _refreshWeatherFolderTag() {
    const mode = this._normalizeWeatherUIMode();
    const labels = { manual: 'Manual', directed: 'Directed', dynamic: 'Dynamic' };
    this._setFolderTag('weather', labels[mode] || 'Manual');
  }

  /**
   * @returns {'manual'|'directed'|'dynamic'}
   * @private
   */
  _normalizeWeatherUIMode() {
    return inferWeatherPanelView(this.controlState);
  }

  /**
   * Broadcast current weather panel mode to connected players.
   * @private
   */
  _emitWeatherModeSync() {
    try {
      getWeatherSyncBridge().emitMode(this.controlState, { immediate: true });
    } catch (_) {}
  }

  /**
   * @param {'manual'|'directed'|'dynamic'} mode
   * @private
   */
  _setWeatherUIMode(mode) {
    const next = mode === 'dynamic' ? 'dynamic' : mode === 'directed' ? 'directed' : 'manual';
    const prev = this._normalizeWeatherUIMode();
    if (prev === next) return;

    const prevRuntimeDynamic = this.controlState.weatherMode === 'dynamic' && this.controlState.dynamicEnabled === true;

    this.controlState.weatherPanelView = next;
    if (next === 'dynamic') {
      this.controlState.weatherMode = 'dynamic';
      this.controlState.dynamicEnabled = true;
    } else {
      this.controlState.weatherMode = 'directed';
      this.controlState.dynamicEnabled = false;
    }

    this._updateWeatherControls();
    this._applyWeatherPanelViewVisibility();

    const nextRuntimeDynamic = next === 'dynamic';
    const uiOnlySwitch =
      (prev === 'manual' || prev === 'directed') &&
      (next === 'manual' || next === 'directed');

    if (uiOnlySwitch || prevRuntimeDynamic === nextRuntimeDynamic) {
      void this._persistWeatherPanelModeChange({ runtime: false });
      return;
    }

    refreshMsaSameSceneRedrawPredict();
    void this._applyWeatherModeRuntime();
  }

  /**
   * Persist weather panel mode and broadcast to players.
   * @param {{ runtime?: boolean }} [opts]
   * @private
   */
  async _persistWeatherPanelModeChange(opts = {}) {
    if (opts.runtime === true) {
      try {
        refreshMsaSameSceneRedrawPredict();

        const weatherState = {
          mode: this.controlState.weatherMode,
          dynamicEnabled: this.controlState.dynamicEnabled,
          dynamicPresetId: this.controlState.dynamicPresetId,
          dynamicEvolutionSpeed: this.controlState.dynamicEvolutionSpeed,
          dynamicPaused: this.controlState.dynamicPaused,
        };
        await stateApplier.applyWeatherState(weatherState, false);

        this._syncLandscapeLightningAndFogFromControlState();
        this._updateStatusPanel();

        const wc = resolveWeatherController();
        if (this.controlState.dynamicEnabled === true) {
          await wc?.saveDynamicStateNow?.();
        }
      } catch (error) {
        log.error('Failed to apply weather UI mode runtime:', error);
      }
    }

    await this._saveControlState();
    this._emitWeatherModeSync();
  }

  /**
   * Apply dynamic/directed runtime switch and persist to scene flags.
   * @private
   */
  async _applyWeatherModeRuntime() {
    await this._persistWeatherPanelModeChange({ runtime: true });
  }

  /**
   * Stable fingerprint of weather UI state that maps to _applyRapidWeatherOverrides / WC.
   * Excludes time-of-day so changing the clock does not re-trigger rapid custom apply.
   * @returns {string}
   * @private
   */
  _weatherControlFingerprint() {
    const d = this.controlState?.directedCustomPreset ?? {};
    const payload = {
      weatherMode: this.controlState?.weatherMode,
      dynamicEnabled: this.controlState?.dynamicEnabled,
      dynamicPresetId: this.controlState?.dynamicPresetId,
      dynamicEvolutionSpeed: this.controlState?.dynamicEvolutionSpeed,
      dynamicPaused: this.controlState?.dynamicPaused,
      directedPresetId: this.controlState?.directedPresetId,
      custom: {
        precipitation: d.precipitation,
        cloudCover: d.cloudCover,
        freezeLevel: d.freezeLevel,
        windSpeed: d.windSpeed,
        windDirection: d.windDirection,
        fogDensity: d.fogDensity
      },
      windSpeedMS: this.controlState?.windSpeedMS,
      windDirectionTop: this.controlState?.windDirection
    };
    try {
      return JSON.stringify(payload);
    } catch (_) {
      return String(Math.random());
    }
  }

  /**
   * Build the compact live-play layout.
   * Keeps frequently used controls in one streamlined section.
   * @private
   */
  _buildPhaseALayout() {
    this._ensureDirectedCustomPreset();
    if (!this._shell?.zones) return;

    this._normalizeWeatherUIMode();
    this._buildHeaderModeToggle();
    this._buildDialZone(this._shell.zones.dial);
    this._buildWeatherStatusZone(this._shell.weatherStatusStrip);
    this._buildStickControls(this._shell.stickControls);
    this._buildMixerZone(this._shell.zones.mixer);
    this._buildAdvancedDeck(this._shell.zones.advanced);
    this._buildCompactTileMotionStrip(this._shell.tileMotionStrip);
    this._applyWeatherPanelViewVisibility();
    this._mountMinimizeButton();
  }

  /**
   * Manual | Directed | Dynamic mode switch at panel top.
   * @private
   */
  _buildHeaderModeToggle() {
    if (!this._shell?.modeBar) return;
    this._shell.modeBar.replaceChildren();

    const current = this._normalizeWeatherUIMode();

    this._weatherViewSegment = createSegmentedControl(
      { Manual: 'manual', Directed: 'directed', Dynamic: 'dynamic' },
      current,
      (v) => this._setWeatherUIMode(v),
    );
    this._weatherViewSegment.wrap.classList.add('msa-cp__mode-segment', 'msa-cp__mode-segment--triple');
    this._shell.modeBar.appendChild(this._weatherViewSegment.wrap);
  }

  /**
   * Astrolabe wheel in the remote head with weather preset fingers.
   * @private
   */
  _buildDialZone(zoneEl) {
    zoneEl.replaceChildren();
    this._weatherPresetButtons = [];

    const stage = document.createElement('div');
    stage.className = 'msa-cp-dial-stage';

    const dialCenter = document.createElement('div');
    dialCenter.className = 'msa-cp-dial-center';

    const leftFingers = document.createElement('div');
    leftFingers.className = 'msa-cp-weather-fingers msa-cp-weather-fingers--left';
    leftFingers.dataset.side = 'left';

    const rightFingers = document.createElement('div');
    rightFingers.className = 'msa-cp-weather-fingers msa-cp-weather-fingers--right';
    rightFingers.dataset.side = 'right';

    this._buildAstrolabeHero(dialCenter);
    this._buildWeatherFingers(leftFingers, WEATHER_FINGER_PRESETS.left, 'left');
    this._buildWeatherFingers(rightFingers, WEATHER_FINGER_PRESETS.right, 'right');

    stage.appendChild(leftFingers);
    stage.appendChild(rightFingers);
    stage.appendChild(dialCenter);
    zoneEl.appendChild(stage);

    this._weatherFingerLeft = leftFingers;
    this._weatherFingerRight = rightFingers;
  }

  /**
   * Weather status readout under the dial (director detail vs manual compact).
   * @param {HTMLElement} mountEl
   * @private
   */
  _buildWeatherStatusZone(mountEl) {
    mountEl.replaceChildren();
    mountEl.classList.add('msa-cp__status-led');
    this.statusPanel = null;
    this._buildStatusPanel(mountEl);

    const hintEl = document.createElement('div');
    hintEl.className = 'msa-cp-context-hint';
    hintEl.setAttribute('aria-live', 'polite');
    for (let i = 0; i < 3; i++) {
      const line = document.createElement('div');
      line.className = 'msa-cp-context-hint__line';
      hintEl.appendChild(line);
    }
    mountEl.appendChild(hintEl);
    this._contextHintEl = hintEl;
    this._renderContextHintLines(CONTEXT_HINT_IDLE);

    this._applyWeatherStatusStripMode();
  }

  /**
   * @param {string|string[]} text
   * @returns {string[]}
   * @private
   */
  _normalizeHintLines(text) {
    if (Array.isArray(text)) {
      const lines = text.map((l) => String(l ?? '').trim()).slice(0, 3);
      while (lines.length < 3) lines.push('');
      return lines;
    }
    const s = String(text ?? '').trim();
    if (!s) return ['', '', ''];
    if (s.includes('\n')) {
      return this._normalizeHintLines(s.split('\n').map((l) => l.trim()).filter(Boolean));
    }
    return [s, '', ''];
  }

  /**
   * @param {string[]} lines
   * @private
   */
  _renderContextHintLines(lines) {
    if (!this._contextHintEl) return;
    const kids = this._contextHintEl.querySelectorAll('.msa-cp-context-hint__line');
    const normalized = this._normalizeHintLines(lines);
    for (let i = 0; i < 3; i++) {
      if (kids[i]) kids[i].textContent = normalized[i] || '\u00a0';
    }
  }

  /**
   * @param {string} source
   * @param {string|string[]} text
   * @private
   */
  _setContextHint(source, text) {
    if (!source || !text) return;
    this._contextHintSources.set(source, this._normalizeHintLines(text));
    this._refreshContextHint();
  }

  /**
   * @param {string} source
   * @private
   */
  _clearContextHint(source) {
    if (!source) return;
    this._contextHintSources.delete(source);
    this._refreshContextHint();
  }

  /** @private */
  _refreshContextHint() {
    if (!this._contextHintEl) return;
    const order = ['time-drag', 'dial', 'fader', 'stick'];
    for (const key of order) {
      const lines = this._contextHintSources.get(key);
      if (lines) {
        this._renderContextHintLines(lines);
        return;
      }
    }
    this._renderContextHintLines(CONTEXT_HINT_IDLE);
  }

  /**
   * @param {HTMLElement} el
   * @param {string|(() => string)} textOrFn
   * @private
   */
  _bindContextHint(el, textOrFn) {
    if (!el) return;
    el.addEventListener('pointerenter', () => {
      const text = typeof textOrFn === 'function' ? textOrFn() : textOrFn;
      if (text) this._setContextHint('stick', text);
    });
    el.addEventListener('pointerleave', () => this._clearContextHint('stick'));
  }

  /** @private */
  _applyWeatherStatusStripMode() {
    const mode = this._normalizeWeatherUIMode();
    const isCompact = mode === 'manual' || mode === 'directed';
    const isDynamic = mode === 'dynamic';

    if (this._shell?.weatherStatusStrip) {
      const strip = this._shell.weatherStatusStrip;
      strip.classList.toggle('is-compact-view', isCompact);
      strip.classList.toggle('is-dynamic-view', isDynamic);
      strip.classList.remove('is-manual-view', 'is-directed-view');
    }
    if (this.statusPanel) {
      this.statusPanel.classList.toggle('is-compact-view', isCompact);
      this.statusPanel.classList.toggle('is-dynamic-view', isDynamic);
      this.statusPanel.classList.remove('is-manual-view', 'is-directed-view');
    }
  }

  /**
   * @param {HTMLElement} mountEl
   * @param {Array<{ id: string, icon: string, label: string }>} presets
   * @param {'left'|'right'} side
   * @private
   */
  _buildWeatherFingers(mountEl, presets, side) {
    mountEl.replaceChildren();
    mountEl.dataset.side = side;
    if (!this._weatherPresetButtons) this._weatherPresetButtons = [];

    const count = presets.length;

    for (let i = 0; i < count; i++) {
      const preset = presets[i];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'msa-cp-weather-finger';
      btn.title = preset.id;
      btn.dataset.presetId = preset.id;
      btn.dataset.slot = String(i);

      const iconSpan = document.createElement('span');
      iconSpan.className = 'msa-cp-weather-finger__icon';
      iconSpan.textContent = preset.icon;

      const labelSpan = document.createElement('span');
      labelSpan.className = 'msa-cp-weather-finger__label';
      labelSpan.textContent = preset.label;

      btn.appendChild(iconSpan);
      btn.appendChild(labelSpan);

      const stackH = count * WEATHER_FINGER_H_PX + (count - 1) * WEATHER_FINGER_GAP_PX;
      const startY = (WEATHER_FINGER_STAGE_H_PX - stackH) / 2;
      btn.style.top = `${startY + i * (WEATHER_FINGER_H_PX + WEATHER_FINGER_GAP_PX)}px`;
      const arcOut = WEATHER_FINGER_ARC_OFFSETS[i] ?? 0;
      const tx = side === 'left' ? -arcOut : arcOut;
      btn.style.transform = `translateX(${tx}px)`;

      btn.addEventListener('click', () => {
        triggerPanelClunk(this.container);
        void this._applyQuickWeatherBeat(preset.id).then(() => {
          this.debouncedSave();
          this._mirrorWeatherPresetButtons();
        });
      });

      this._bindContextHint(btn, () => [
        `Weather Preset — ${preset.label}`,
        'Click to apply this weather beat',
        preset.id,
      ]);

      mountEl.appendChild(btn);
      this._weatherPresetButtons.push(btn);
    }
  }

  /**
   * Compact time controls at top of the stick body.
   * @param {HTMLElement} mountEl
   * @private
   */
  _buildStickControls(mountEl) {
    mountEl.replaceChildren();

    const refreshTimeFolderTag = () => {
      const mins = Number(this.controlState.timeTransitionMinutes) || 0;
      if (this.controlState.linkTimeToFoundry) {
        this._setFolderTag('time', 'VTT Sync');
      } else if (mins > 0) {
        this._setFolderTag('time', formatFadeMinutes(mins));
      } else {
        this._setFolderTag('time', 'Now');
      }
    };
    this._refreshTimeFolderTag = refreshTimeFolderTag;

    const lockRow = document.createElement('div');
    lockRow.className = 'msa-cp-stick-lock';

    const lockBtn = document.createElement('button');
    lockBtn.type = 'button';
    lockBtn.className = 'msa-cp-stick-lock__btn';
    lockBtn.title = 'Sync Map Shine time with Foundry VTT world clock';
    lockBtn.textContent = '🔓 Sync Foundry VTT Time';
    lockBtn.disabled = !(isGmLike());
    lockBtn.addEventListener('click', () => {
      const next = !lockBtn.classList.contains('is-locked');
      lockBtn.classList.toggle('is-locked', next);
      lockBtn.textContent = next ? '🔒 Synced to Foundry VTT' : '🔓 Sync Foundry VTT Time';
      this.controlState.linkTimeToFoundry = next;
      refreshTimeFolderTag();
      if (next) {
        void this._syncTimeFromFoundryWorldTime(game?.time?.worldTime, false);
      }
      this.debouncedSave();
    });
    this._foundryLockBtn = lockBtn;
    lockRow.appendChild(lockBtn);
    mountEl.appendChild(lockRow);

    this._bindContextHint(lockBtn, () => (
      this.controlState.linkTimeToFoundry
        ? [
          'Foundry Time Sync — locked',
          'Map Shine follows the VTT world clock',
          'Click to unlock manual time control',
        ]
        : [
          'Foundry Time Sync — off',
          'Click to mirror Map Shine time to Foundry VTT',
          'Use the dial ring for manual time when unlocked',
        ]
    ));

    this._timeScaleParams = { timeRate: this._getTimeScalePercent() };
    const scaleStepper = createStepperControl({
      label: 'Time Speed',
      hint: 'passage rate',
      title: 'How fast in-scene time passes relative to real time (100% = normal)',
      value: this._timeScaleParams.timeRate,
      min: 0,
      max: 200,
      step: 5,
      format: (v) => `${Math.round(v)}%`,
      onChange: (v) => this._applyTimeScale(v),
    });
    this._timeScaleControl = scaleStepper;
    mountEl.appendChild(scaleStepper.row);

    this._bindContextHint(scaleStepper.row, () => [
      `Time Speed — ${Math.round(this._getTimeScalePercent())}%`,
      'How fast in-scene time passes vs real time',
      '100% = normal · 0% = paused',
    ]);

    const fadeRow = document.createElement('div');
    fadeRow.className = 'msa-cp-fade-row';

    const transSlider = createFadeTimeSlider({
      label: 'Environment Fade',
      hint: 'instant → 30 min',
      title: 'How long time, weather, wind, fog, lightning, and ash take to blend (Instant = immediate jump)',
      value: Number(this.controlState.timeTransitionMinutes) || 0,
      onChange: (v) => {
        this.controlState.timeTransitionMinutes = v;
        refreshTimeFolderTag();
        this.debouncedSave();
      },
    });
    this._timeTransitionStepper = transSlider;
    fadeRow.appendChild(transSlider.row);
    mountEl.appendChild(fadeRow);

    this._bindContextHint(transSlider.row, () => {
      const mins = Number(this.controlState.timeTransitionMinutes) || 0;
      const fade = mins > 0 ? formatFadeMinutes(mins) : 'Instant';
      return [
        `Environment Fade — ${fade}`,
        'Blends clock, weather sliders, wind, fog, lightning, and ash together',
        'Dashed previews show targets before you release',
      ];
    });

    lockBtn.classList.toggle('is-locked', this.controlState.linkTimeToFoundry === true);
    lockBtn.textContent = this.controlState.linkTimeToFoundry ? '🔒 Synced to Foundry VTT' : '🔓 Sync Foundry VTT Time';
    refreshTimeFolderTag();
  }

  /**
   * Compact tile motion transport above Advanced Settings.
   * @param {HTMLElement} mountEl
   * @private
   */
  _buildCompactTileMotionStrip(mountEl) {
    mountEl.replaceChildren();
    const canEditTileMotion = isGmLike() && !!window.MapShine?.tileMotionManager;

    const header = document.createElement('div');
    header.className = 'msa-cp-tile-motion-strip__header';

    const title = document.createElement('span');
    title.className = 'msa-cp-tile-motion-strip__title';
    title.textContent = 'Tile Motion';

    const tag = document.createElement('span');
    tag.className = 'msa-cp-tile-motion-strip__tag';
    tag.textContent = `${Math.round(Number(this.controlState.tileMotionSpeedPercent) || 0)}%`;
    this._tileMotionStripTag = tag;

    header.appendChild(title);
    header.appendChild(tag);
    mountEl.appendChild(header);

    const transport = document.createElement('div');
    transport.className = 'msa-cp-tile-motion-strip__transport';

    const transportDefs = [
      { icon: '▶', label: 'Start', fn: () => this._startTileMotion() },
      { icon: '⏸', label: 'Pause', fn: () => this._pauseTileMotion() },
      { icon: '⏵', label: 'Resume', fn: () => this._resumeTileMotion() },
      { icon: '⏹', label: 'Stop', fn: () => this._stopTileMotion() },
    ];

    for (const def of transportDefs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'msa-cp-tile-motion-strip__btn';
      btn.title = def.label;
      btn.setAttribute('aria-label', def.label);
      btn.textContent = def.icon;
      btn.disabled = !canEditTileMotion;
      btn.addEventListener('click', () => { void def.fn(); });
      this._bindContextHint(btn, [
        `Tile Motion — ${def.label}`,
        canEditTileMotion ? 'GM transport control' : 'GM only',
        'Speed slider below sets playback rate',
      ]);
      transport.appendChild(btn);
    }

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'msa-cp-tile-motion-strip__btn msa-cp-tile-motion-strip__btn--reset';
    resetBtn.title = 'Reset Phase';
    resetBtn.setAttribute('aria-label', 'Reset Phase');
    resetBtn.textContent = '↺';
    resetBtn.disabled = !canEditTileMotion;
    resetBtn.addEventListener('click', () => { void this._resetTileMotionPhase(); });
    this._bindContextHint(resetBtn, [
      'Tile Motion — Reset Phase',
      'Restarts the motion cycle from the beginning',
      canEditTileMotion ? 'GM only control' : 'GM only',
    ]);
    transport.appendChild(resetBtn);

    mountEl.appendChild(transport);

    const speedRow = document.createElement('div');
    speedRow.className = 'msa-cp-tile-motion-strip__speed';

    const speedCtrl = createNativeControl({
      type: 'range',
      label: 'Speed',
      target: this.controlState,
      key: 'tileMotionSpeedPercent',
      min: 0,
      max: 400,
      step: 1,
      disabled: !canEditTileMotion,
      onChange: (v, last) => {
        if (!Number.isFinite(Number(v))) return;
        this.controlState.tileMotionSpeedPercent = v;
        this._updateTileMotionStripTag(v);
        void this._setTileMotionSpeed(v, { persist: last === true });
        if (last) this.debouncedSave();
      },
    });
    speedCtrl.row.classList.add('msa-cp-tile-motion-strip__speed-row');
    this._tileMotionSpeedBinding = speedCtrl;
    speedRow.appendChild(speedCtrl.row);
    mountEl.appendChild(speedRow);

    this._bindContextHint(speedCtrl.row, () => [
      `Tile Motion Speed — ${Math.round(Number(this.controlState.tileMotionSpeedPercent) || 0)}%`,
      'Playback rate for animated tiles',
      '100% = authored speed · drag to adjust live',
    ]);

    if (!canEditTileMotion) {
      const hint = document.createElement('div');
      hint.className = 'msa-cp-tile-motion-strip__hint';
      hint.textContent = isGmLike()
        ? 'Tile motion manager not ready'
        : 'GM only';
      mountEl.appendChild(hint);
    }
  }

  /**
   * Lightning strike buttons below faders in the stick.
   * @param {HTMLElement} mountEl
   * @private
   */
  _buildStrikeRow(mountEl) {
    mountEl.replaceChildren();

    const pad = document.createElement('div');
    pad.className = 'msa-cp-strike-pad';

    const label = document.createElement('div');
    label.className = 'msa-cp-strike-pad__label';
    label.textContent = 'Manual lightning strikes';
    pad.appendChild(label);

    const hint = document.createElement('div');
    hint.className = 'msa-cp-strike-pad__hint';
    hint.textContent = 'Trigger landscape flashes — separate from the ⚡ intensity slider above';
    pad.appendChild(hint);

    const strikeGrid = document.createElement('div');
    strikeGrid.className = 'msa-cp-strike-pad__buttons';
    strikeGrid.dataset.msLiveWxStrikes = '1';

    for (const [btnLabel, actionId] of [['Small', 'small'], ['Big', 'big'], ['30s burst', 'series']]) {
      const btn = createCpButton(btnLabel, () => triggerLandscapeLightningAction(actionId));
      const strikeHints = {
        small: [
          'Manual Lightning — Small strike',
          'One brief landscape flash',
          'Separate from the ⚡ intensity slider',
        ],
        big: [
          'Manual Lightning — Big strike',
          'One heavy landscape flash',
          'Separate from the ⚡ intensity slider',
        ],
        series: [
          'Manual Lightning — 30s burst',
          'Rapid strikes for half a minute',
          'Separate from the ⚡ intensity slider',
        ],
      };
      this._bindContextHint(btn, strikeHints[actionId] || [`Manual Lightning — ${btnLabel}`, '', '']);
      strikeGrid.appendChild(btn);
    }
    pad.appendChild(strikeGrid);
    mountEl.appendChild(pad);
  }

  /**
   * Zone C: Manual weather faders (wired when manual view active).
   * @private
   */
  _buildMixerZone(zoneEl) {
    this._mixerZoneEl = zoneEl;

    const dynamicMount = document.createElement('div');
    dynamicMount.className = 'msa-cp-mixer-dynamic';
    dynamicMount.dataset.msWeatherPanelView = 'dynamic';

    const faderMount = document.createElement('div');
    faderMount.className = 'msa-cp-mixer-shared__faders';

    const manualWrap = document.createElement('div');
    manualWrap.className = 'msa-cp-mixer-manual';
    manualWrap.dataset.msWeatherPanelView = 'manual';

    const strikeMount = document.createElement('div');
    strikeMount.className = 'msa-cp-mixer-manual__strikes';
    manualWrap.appendChild(strikeMount);

    zoneEl.appendChild(dynamicMount);
    zoneEl.appendChild(faderMount);
    zoneEl.appendChild(manualWrap);

    this._weatherDynamicMixerEl = dynamicMount;
    this._weatherManualViewEl = faderMount;
    this._weatherStrikeMountEl = strikeMount;
    this._buildDynamicMixerDeck(dynamicMount);
    this._wireLiveWeatherOverrideBindingsIfReady();
    this._buildStrikeRow(strikeMount);
  }

  /**
   * Primary Dynamic Weather deck in the main stick body.
   * @param {HTMLElement} mountEl
   * @private
   */
  _buildDynamicMixerDeck(mountEl) {
    this._dynamicWeatherDeck = createDynamicWeatherDeck(mountEl, {
      controlState: this.controlState,
      getWeatherController: () => resolveWeatherController(),
      isGm: () => isGmLike(),
      onApply: () => this._applyControlState(),
      onSave: () => this.debouncedSave(),
      onSaveDynamic: async () => {
        try {
          await resolveWeatherController()?.saveDynamicStateNow?.();
        } catch (_) {}
      },
      setContextHint: (lines) => this._setContextHint('stick', lines),
      clearContextHint: () => this._clearContextHint('stick'),
    });
  }

  /**
   * Advanced collapsible sections.
   * @private
   */
  _buildAdvancedDeck(zoneEl) {
    const directorSec = createSection(zoneEl, {
      id: 'weatherDirector',
      title: '🌦 Weather Director',
      tagKey: 'weather',
      expanded: false,
    });
    this._ensureSectionTag(directorSec, 'weather', 'Manual');
    this._weatherDirectorViewEl = directorSec.body;
    this._registerSection({ id: 'weatherDirector', setExpanded: directorSec.setExpanded });
    this._buildWeatherDirectorContents(directorSec.body);

    const occlSec = createSection(zoneEl, {
      id: 'overheadOccl',
      title: '🔳 Overhead Occlusion',
      tagKey: 'overheadOccl',
      expanded: false,
    });
    this._ensureSectionTag(occlSec, 'overheadOccl', 'V2');
    this._registerSection({ id: 'overheadOccl', setExpanded: occlSec.setExpanded });
    this._buildOverheadOcclusionSection(occlSec.body);

    const lightsSec = createSection(zoneEl, {
      id: 'playerLights',
      title: '🔦 Player Lights',
      tagKey: 'playerLights',
      expanded: false,
    });
    this._ensureSectionTag(lightsSec, 'playerLights', 'GM');
    this._registerSection({ id: 'playerLights', setExpanded: lightsSec.setExpanded });
    this._buildPlayerLightsSection(lightsSec.body);
  }

  /**
   * Default scalar bag for directed Custom — used by merge + NaN sanitization.
   * @private
   */
  _directedCustomPresetDefaults() {
    return {
      precipitation: 0.0,
      cloudCover: 0.15,
      windSpeed: Math.max(0.0, Math.min(1.0, (Number(this.controlState?.windSpeedMS) || 0.0) / 78.0)),
      windDirection: Number.isFinite(Number(this.controlState?.windDirection)) ? Number(this.controlState.windDirection) : 180.0,
      fogDensity: 0.0,
      freezeLevel: 0.0
    };
  }

  /**
   * Tweakpane's number input accepts `typeof x === 'number'` including NaN — that yields "NaN" in the UI.
   * Force finite numbers on the binding target whenever we merge or mirror from WC.
   * @param {object} target
   * @param {object} [defaults] — from `_directedCustomPresetDefaults()`; built if omitted
   * @private
   */
  _sanitizeDirectedCustomPresetNumbers(target, defaults) {
    if (!target || typeof target !== 'object') return;
    const d = defaults && typeof defaults === 'object' ? defaults : this._directedCustomPresetDefaults();

    const finite01 = (v, fb) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return fb;
      return Math.max(0.0, Math.min(1.0, n));
    };
    const finiteDeg = (v, fb) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return fb;
      const out = ((n % 360) + 360) % 360;
      return Number.isFinite(out) ? out : fb;
    };

    target.precipitation = finite01(target.precipitation, d.precipitation);
    target.cloudCover = finite01(target.cloudCover, d.cloudCover);
    target.windSpeed = finite01(target.windSpeed, d.windSpeed);
    target.fogDensity = finite01(target.fogDensity, d.fogDensity);
    target.freezeLevel = finite01(target.freezeLevel, d.freezeLevel);
    target.windDirection = finiteDeg(target.windDirection, d.windDirection);
  }

  /**
   * Coerce panel wind fields so Tweakpane number blades never stick on NaN.
   * @private
   */
  _coercePanelWindScalarsInPlace() {
    if (!this.controlState || typeof this.controlState !== 'object') return;
    const wms = Number(this.controlState.windSpeedMS);
    this.controlState.windSpeedMS = Number.isFinite(wms)
      ? Math.max(0.0, Math.min(MAX_WIND_MS_CP, wms))
      : 39.0;
    const wd = Number(this.controlState.windDirection);
    this.controlState.windDirection = Number.isFinite(wd)
      ? ((wd % 360) + 360) % 360
      : 180.0;
  }

  /**
   * Refresh Tweakpane blades for the Wind section (after programmatic WC → panel sync).
   * @private
   */
  _refreshWindPaneBindings() {
    this._mirrorWindCompassFromState();
  }

  _windAngleDegFromController(wc, dir) {
    if (typeof wc?._windAngleDegFromDir === 'function') {
      return wc._windAngleDegFromDir(dir);
    }
    const x = Number.isFinite(Number(dir?.x)) ? Number(dir.x) : 1.0;
    const y = Number.isFinite(Number(dir?.y)) ? Number(dir.y) : 0.0;
    const deg = Math.atan2(-y, x) * (180.0 / Math.PI);
    return deg < 0 ? (deg + 360.0) : deg;
  }

  _mirrorWindCompassFromState(liveSpeedMS = null, gustPulse = null, liveDirectionDeg = null) {
    if (!this._astrolabe) return;
    this._coercePanelWindScalarsInPlace();
    this._astrolabe.mirror({
      speedMS: Number(this.controlState.windSpeedMS) || 0,
      directionDeg: Number.isFinite(liveDirectionDeg)
        ? liveDirectionDeg
        : (Number(this.controlState.windDirection) || 0),
      gustiness: this.controlState.gustiness || 'moderate',
      liveSpeedMS: Number.isFinite(liveSpeedMS) ? liveSpeedMS : null,
      gustPulse: Number.isFinite(gustPulse) ? gustPulse : null,
    });
    const ms = Number.isFinite(liveSpeedMS) ? liveSpeedMS : (Number(this.controlState.windSpeedMS) || 0);
    this._setFolderTag('wind', `${Math.round(ms)} m/s`);
    if (this._liveWeatherOverrideDom?.rows?.gustiness) {
      const gIdx = GUSTINESS_LABELS.indexOf(this.controlState.gustiness || 'moderate');
      mirrorFaderRow(this._liveWeatherOverrideDom.rows, 'gustiness', gIdx >= 0 ? gIdx : 2);
    }
  }

  _mirrorAllDomFromState() {
    try {
      this.syncLiveWeatherOverrideDomFromDirectedPreset();
      this.syncManualFogDomFromControlState();
      this.syncLiveLightningDomFromControlState();
      this.syncManualAshDomFromController();
      this._syncReplicaOcclDomFromControlState();
      this._mirrorWindCompassFromState();
      this._timeScaleControl?.mirror?.(this._getTimeScalePercent());
      this._timeTransitionStepper?.mirror?.(Number(this.controlState.timeTransitionMinutes) || 0);
      for (const ctrl of Object.values(this._nativeControls || {})) {
        try { ctrl.mirror?.(); } catch (_) {}
      }
      if (this._weatherViewSegment?.mirror) {
        this._weatherViewSegment.mirror(this._normalizeWeatherUIMode());
      }
      if (this._weatherModeSegment?.mirror) {
        this._weatherModeSegment.mirror(this.controlState.weatherMode || 'dynamic');
      }
      this._updateClock(this.controlState.timeOfDay);
      updatePhaseRing(this.clockElements?.phaseRing, this.controlState.timeOfDay);
      this._mirrorWeatherPresetButtons();
      this._dynamicWeatherDeck?.mirror?.();
    } catch (_) {}
  }

  _injectPanelStyles() {
    /* Styles live in styles/module.css (.msa-cp) */
  }

  _ensureDirectedCustomPreset() {
    const defaults = this._directedCustomPresetDefaults();

    const clamp01 = (v, fallback) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return fallback;
      return Math.max(0.0, Math.min(1.0, n));
    };

    const custom = this.controlState?.directedCustomPreset;
    const source = (custom && typeof custom === 'object') ? custom : {};

    let target = (this._rapidWeatherBindingTarget && typeof this._rapidWeatherBindingTarget === 'object')
      ? this._rapidWeatherBindingTarget
      : null;
    if (!target) {
      target = (custom && typeof custom === 'object') ? custom : {};
      this._rapidWeatherBindingTarget = target;
    }

    target.precipitation = clamp01(source.precipitation, defaults.precipitation);
    target.cloudCover = clamp01(source.cloudCover, defaults.cloudCover);
    target.windSpeed = clamp01(source.windSpeed, defaults.windSpeed);
    target.fogDensity = clamp01(source.fogDensity, defaults.fogDensity);
    target.freezeLevel = clamp01(source.freezeLevel, defaults.freezeLevel);

    const dir = Number(source.windDirection);
    target.windDirection = Number.isFinite(dir)
      ? ((dir % 360) + 360) % 360
      : defaults.windDirection;

    this._sanitizeDirectedCustomPresetNumbers(target, defaults);
    this.controlState.directedCustomPreset = target;
  }

  /**
   * Unified weather shell: presets, Manual/Director toggle (Zone A macro pad).
   * @param {HTMLElement} zoneEl
   * @private
   */
  _buildUnifiedWeatherSection(zoneEl) {
    this._ensureDirectedCustomPreset();

    if (this.controlState.weatherPanelView === 'director') {
      this._normalizeWeatherUIMode();
    }

    const presetsWrap = document.createElement('div');
    presetsWrap.className = 'msa-cp-macro-zone';
    this._appendWeatherPresetsGrid(presetsWrap);
    zoneEl.appendChild(presetsWrap);

    const windGrid = document.createElement('div');
    windGrid.className = 'msa-cp-macro-pad msa-cp-wind-presets';
    const beats = {
      Calm: { speedMS: 4.0, gustiness: 'calm' },
      Breezy: { speedMS: 14.0, gustiness: 'light' },
      Windy: { speedMS: 28.0, gustiness: 'strong' },
      Storm: { speedMS: 50.0, gustiness: 'extreme' },
    };
    for (const [label, cfg] of Object.entries(beats)) {
      windGrid.appendChild(createCpButton(label, () => {
        this.controlState.windSpeedMS = cfg.speedMS;
        this.controlState.gustiness = cfg.gustiness;
        this._coercePanelWindScalarsInPlace();
        void this._applyWindState();
        this._mirrorWindCompassFromState();
        this.debouncedSave();
        triggerPanelClunk(this.container);
      }));
    }
    zoneEl.appendChild(windGrid);

    this._refreshWeatherFolderTag();
    this._applyWeatherPanelViewVisibility();
    this._mirrorWeatherPresetButtons();
  }

  /**
   * @param {HTMLElement} container
   * @private
   */
  _appendWeatherPresetsGrid(container) {
    const weatherGrid = document.createElement('div');
    weatherGrid.className = 'msa-cp-macro-pad';
    const weatherBeats = {
      'Clear ☀️': 'Clear (Dry)',
      'Rain 🌧️': 'Rain',
      'Storm ⛈️': 'Thunderstorm',
      'Snow ❄️': 'Snow',
    };
    /** @type {HTMLButtonElement[]} */
    this._weatherPresetButtons = [];
    for (const [label, presetId] of Object.entries(weatherBeats)) {
      const btn = createCpButton(label, () => {
        triggerPanelClunk(this.container);
        void this._applyQuickWeatherBeat(presetId).then(() => {
          this.debouncedSave();
          this._mirrorWeatherPresetButtons();
        });
      });
      btn.dataset.presetId = presetId;
      weatherGrid.appendChild(btn);
      this._weatherPresetButtons.push(btn);
    }
    container.appendChild(weatherGrid);
  }

  /** @private */
  _mirrorWeatherPresetButtons() {
    const active = this.controlState?.directedPresetId || '';
    for (const btn of this._weatherPresetButtons || []) {
      btn.classList.toggle('is-active', btn.dataset.presetId === active);
    }
  }

  /**
   * @param {'manual'|'directed'|'dynamic'} view
   * @private
   */
  _setWeatherPanelView(view) {
    this._setWeatherUIMode(view);
  }

  /** @private */
  _applyWeatherPanelViewVisibility() {
    const mode = this._normalizeWeatherUIMode();
    const isManual = mode === 'manual';
    const isDirected = mode === 'directed';
    const isDynamic = mode === 'dynamic';

    if (this._mixerZoneEl) {
      this._mixerZoneEl.style.display = (isManual || isDynamic) ? '' : 'none';
    }
    if (this._weatherDynamicMixerEl) {
      this._weatherDynamicMixerEl.style.display = isDynamic ? '' : 'none';
    }
    if (this._weatherManualViewEl) {
      this._weatherManualViewEl.style.display = isManual ? '' : 'none';
    }
    if (this._weatherStrikeMountEl?.closest('.msa-cp-mixer-manual')) {
      this._weatherStrikeMountEl.closest('.msa-cp-mixer-manual').style.display = isManual ? '' : 'none';
    }
    if (this._shell?.strikeZone) {
      this._shell.strikeZone.style.display = 'none';
    }
    if (this._weatherFingerLeft) {
      this._weatherFingerLeft.style.display = isDirected ? '' : 'none';
    }
    if (this._weatherFingerRight) {
      this._weatherFingerRight.style.display = isDirected ? '' : 'none';
    }
    if (this._weatherDirectorViewEl) {
      const directorSection = this._weatherDirectorViewEl.closest('.msa-cp-section');
      if (directorSection) {
        directorSection.style.display = isDirected ? '' : 'none';
      }
    }

    this._applyWeatherStatusStripMode();

    if (this._weatherViewSegment?.mirror) {
      this._weatherViewSegment.mirror(mode);
    }
    this._refreshWeatherFolderTag();
    this._updateManualFogControlAvailability();
    this._updateStatusPanel();
  }

  /**
   * @param {string} param
   * @param {*} raw
   * @param {*} fallback
   * @returns {number}
   */
  _coerceLiveWeatherScalar(param, raw, fallback = 0) {
    const clamp01 = (v, fb) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return fb;
      return Math.max(0, Math.min(1, n));
    };
    let v = raw;
    if (!Number.isFinite(Number(v))) v = fallback;
    if (param === 'windDirection') {
      const n = Number(v);
      if (!Number.isFinite(n)) return 0;
      return ((n % 360) + 360) % 360;
    }
    return clamp01(v, 0);
  }

  /**
   * Keep range + number inputs aligned without firing user handlers.
   * @param {string} paramId
   * @param {number} value
   */
  _mirrorLiveWeatherDomPair(paramId, value) {
    const row = this._liveWeatherOverrideDom?.rows?.[paramId];
    if (!row) return;
    this._suppressLiveWeatherDomEvents = true;
    try {
      if (Number.isFinite(value)) {
        mirrorFaderRow(this._liveWeatherOverrideDom.rows, paramId, value);
        if (row.range) row.range.valueAsNumber = value;
        if (row.number) row.number.valueAsNumber = value;
      }
    } finally {
      this._suppressLiveWeatherDomEvents = false;
    }
  }

  /**
   * Dynamic Weather owns fog density; manual Map Shine Control fog is directed-only.
   * @returns {boolean}
   * @private
   */
  _isDynamicWeatherDrivingFog() {
    return this.controlState?.weatherMode === 'dynamic' && this.controlState?.dynamicEnabled === true;
  }

  /**
   * @param {number} value
   * @param {{ save?: boolean }} [opts]
   * @private
   */
  _commitManualFogDensity(value, opts = {}) {
    if (this._suppressLiveWeatherDomEvents) return;
    if (this._isDynamicWeatherDrivingFog()) return;

    const v = Math.max(0, Math.min(1, Number(value) || 0));
    writeManualFogDensityToControlState(this.controlState, v);
    void environmentControlApi.applyField('manualFogDensity', v, {
      persist: false,
      syncUi: false,
      syncMainTweakpane: false,
    });
    this._mirrorManualFogDomPair(v);

    if (opts.save) {
      this.debouncedSave();
    }
  }

  /**
   * @param {number} value
   * @private
   */
  _mirrorManualFogDomPair(value) {
    this._mirrorLiveWeatherDomPair('manualFogDensity', value);
  }

  /** Sync Fog slider from `controlState.manualFogDensity` (safe before DOM build). */
  syncManualFogDomFromControlState() {
    const v = readManualFogDensityFromControlState(this.controlState);
    this._mirrorManualFogDomPair(v);
    this._updateManualFogControlAvailability();
  }

  /**
   * @param {number} value
   * @param {{ save?: boolean }} [opts]
   * @private
   */
  _commitLiveLightningIntensity(value, opts = {}) {
    if (this._suppressLiveWeatherDomEvents) return;

    const v = Math.max(0, Math.min(1, Number(value) || 0));
    writeLightningIntensityToControlState(this.controlState, v);
    void environmentControlApi.applyField('lightning', v, {
      persist: false,
      syncUi: false,
      syncMainTweakpane: false,
    });
    this._mirrorLiveWeatherDomPair('lightning', v);

    if (opts.save) {
      this.debouncedSave();
    }
  }

  /** Sync Lightning slider from `controlState.landscapeLightning.lightning`. */
  syncLiveLightningDomFromControlState() {
    const v = readLightningIntensityFromControlState(this.controlState);
    this._mirrorLiveWeatherDomPair('lightning', v);
  }

  /**
   * @param {number} value
   * @param {{ save?: boolean }} [opts]
   * @private
   */
  _commitManualAshIntensity(value, opts = {}) {
    if (this._suppressLiveWeatherDomEvents) return;

    const v = applyAshMasterIntensity(value, { syncMainTweakpane: true });
    this._mirrorLiveWeatherDomPair('ashIntensity', v);

    if (opts.save) {
      this._skipNextControlStateSceneFlagPersist = true;
      this.debouncedSave();
    }
  }

  /** Sync Ash slider from WeatherController (safe before DOM build). */
  syncManualAshDomFromController() {
    const v = readAshIntensityFromController();
    this._mirrorLiveWeatherDomPair('ashIntensity', v);
  }

  /**
   * Show or hide the Ash master row when ash effects are enabled in the scene stack.
   */
  refreshAshMasterRowVisibility() {
    const dom = this._liveWeatherOverrideDom;
    const row = dom?.rows?.ashIntensity;
    const el = row?.faderEl || row?.rowEl;
    if (!el) return;

    const show = isAnyAshSystemEnabledInScene();
    el.style.display = show ? '' : 'none';
    if (row.iconEl) row.iconEl.style.display = show ? '' : 'none';
    if (dom?.root) {
      const visibleCount = Object.values(dom.rows).filter(
        (entry) => entry?.faderEl && entry.faderEl.style.display !== 'none',
      ).length;
      dom.root.style.setProperty('--fader-count', String(Math.max(1, visibleCount)));
    }
    if (show) {
      this.syncManualAshDomFromController();
    }
  }

  /**
   * Push landscape lightning + manual fog from control state into runtime effects.
   * @private
   */
  _syncLandscapeLightningAndFogFromControlState() {
    try {
      syncWeatherLightningEffectFromControlState(this.controlState);
      this.syncLiveLightningDomFromControlState();
    } catch (_) {}
    try {
      syncAtmosphericFogEffectFromControlState(this.controlState);
      this.syncManualFogDomFromControlState();
    } catch (_) {}
  }

  /**
   * Enable/disable manual fog row when Dynamic Weather is active.
   * @private
   */
  _updateManualFogControlAvailability() {
    const row = this._liveWeatherOverrideDom?.rows?.manualFogDensity;
    if (!row) return;
    const locked = this._isDynamicWeatherDrivingFog();
    const title = locked ? 'Fog — driven by Dynamic Weather' : 'Fog — manual atmospheric haze (Directed mode)';
    if (row.range) {
      row.range.disabled = locked;
      row.range.title = title;
    }
    if (row.faderEl) row.faderEl.style.opacity = locked ? '0.45' : '';
  }

  /**
   * Apply one live scalar: `directedCustomPreset` → WeatherController → main Tweakpane mirror.
   * @param {string} paramId
   * @param {*} rawValue
   * @param {{ save?: boolean }} [opts]
   */
  _commitLiveWeatherOverrideScalar(paramId, rawValue, opts = {}) {
    if (this._suppressLiveWeatherDomEvents) return;
    if (this._applyingRapidOverrides) return;

    this._ensureDirectedCustomPreset();
    const preset = this.controlState.directedCustomPreset;
    if (!preset || typeof preset !== 'object') return;

    const value = this._coerceLiveWeatherScalar(paramId, rawValue, preset[paramId]);
    preset[paramId] = value;

    this._applyingRapidOverrides = true;
    try {
      this._forceDirectedCustomWeatherMode();
      void environmentControlApi.applyField(paramId, value, {
        persist: false,
        syncUi: false,
        syncMainTweakpane: true,
      });
      this._lastWeatherControlFingerprint = this._weatherControlFingerprint();
      this._updateWeatherControls();
    } finally {
      this._applyingRapidOverrides = false;
    }

    if (paramId === 'windSpeed') {
      this.controlState.windSpeedMS = Math.max(0.0, Math.min(MAX_WIND_MS_CP, Number(value) * MAX_WIND_MS_CP));
    } else if (paramId === 'windDirection') {
      this.controlState.windDirection = Number(value);
    }
    this._coercePanelWindScalarsInPlace();
    this._refreshWindPaneBindings();

    this._mirrorLiveWeatherDomPair(paramId, value);
    // tearDown skip is armed from environment API apply (rain/cloud/wind scalars).
    if (opts.save) {
      this._skipNextControlStateSceneFlagPersist = true;
      this.debouncedSave();
    }
  }

  /**
   * Push `directedCustomPreset` into the native Manual Weather controls (after WC sync / load).
   * Safe to call from `weather-param-bridge`; no-ops if DOM not built yet.
   */
  syncLiveWeatherOverrideDomFromDirectedPreset() {
    if (!this._liveWeatherOverrideDom?.rows) return;
    this._ensureDirectedCustomPreset();
    const preset = this.controlState.directedCustomPreset;
    if (!preset || typeof preset !== 'object') return;
    this._sanitizeDirectedCustomPresetNumbers(preset);
    for (const id of LIVE_WEATHER_OVERRIDE_PARAM_IDS) {
      const v = preset[id];
      if (Number.isFinite(Number(v))) {
        this._mirrorLiveWeatherDomPair(id, Number(v));
      }
    }
  }

  /**
   * Build plain-DOM range+number rows for Manual Weather (not Tweakpane `addBinding`).
   * Idempotent; also callable from `tweakpane-manager` after weather registers.
   */
  _wireLiveWeatherOverrideBindingsIfReady() {
    if (this._liveWeatherOverrideDomBuilt) return;

    const mountEl = this._weatherManualViewEl;
    if (!mountEl) return;

    this._ensureDirectedCustomPreset();
    const preset = this.controlState.directedCustomPreset;
    if (!preset || typeof preset !== 'object') return;

    this._sanitizeDirectedCustomPresetNumbers(preset);
    this._rapidWeatherBindingTarget = preset;

    const specMeta = LIVE_WEATHER_PANEL_SPECS
      .filter((s) => s.id !== 'windSpeed' && s.id !== 'windDirection')
      .map((spec) => ({
        id: spec.id,
        label: spec.label,
        min: spec.min,
        max: spec.max,
        step: spec.step,
        manualFog: spec.backend === 'fog',
        manualLightning: spec.backend === 'lightning',
      }));

    specMeta.push({
      id: 'ashIntensity',
      label: 'Ash',
      min: 0,
      max: 1,
      step: 0.01,
      manualAsh: true,
    });

    specMeta.push({
      id: 'gustiness',
      label: 'Gust',
      min: 0,
      max: GUSTINESS_LABELS.length - 1,
      step: 1,
      manualGustiness: true,
    });

    const board = createFaderBoard(mountEl, specMeta, {
      setContextHint: (text) => this._setContextHint('fader', text),
      clearContextHint: () => this._clearContextHint('fader'),
      wireRow: (pid, range) => {
        const spec = specMeta.find((s) => s.id === pid);
        if (spec?.manualFog) {
          range.addEventListener('input', () => {
            if (this._suppressLiveWeatherDomEvents) return;
            const v = range.valueAsNumber;
            if (!Number.isFinite(v)) return;
            this._handleFadeAwareFaderInput(pid, v, (val) => this._commitManualFogDensity(val, { save: false }));
          });
          range.addEventListener('change', () => {
            if (this._suppressLiveWeatherDomEvents) return;
            const v = range.valueAsNumber;
            if (!Number.isFinite(v)) return;
            this._handleFadeAwareFaderChange(pid, v, (val) => {
              this._commitManualFogDensity(val, { save: false });
              this.debouncedSave();
            });
          });
        } else if (spec?.manualLightning) {
          range.addEventListener('input', () => {
            if (this._suppressLiveWeatherDomEvents) return;
            const v = range.valueAsNumber;
            if (!Number.isFinite(v)) return;
            this._handleFadeAwareFaderInput(pid, v, (val) => this._commitLiveLightningIntensity(val, { save: false }));
          });
          range.addEventListener('change', () => {
            if (this._suppressLiveWeatherDomEvents) return;
            const v = range.valueAsNumber;
            if (!Number.isFinite(v)) return;
            this._handleFadeAwareFaderChange(pid, v, (val) => {
              this._commitLiveLightningIntensity(val, { save: false });
              this.debouncedSave();
            });
          });
        } else if (spec?.manualAsh) {
          range.addEventListener('input', () => {
            if (this._suppressLiveWeatherDomEvents) return;
            const v = range.valueAsNumber;
            if (!Number.isFinite(v)) return;
            this._handleFadeAwareFaderInput(pid, v, (val) => this._commitManualAshIntensity(val, { save: false }));
          });
          range.addEventListener('change', () => {
            if (this._suppressLiveWeatherDomEvents) return;
            const v = range.valueAsNumber;
            if (!Number.isFinite(v)) return;
            this._handleFadeAwareFaderChange(pid, v, (val) => {
              this._commitManualAshIntensity(val, { save: false });
              this._skipNextControlStateSceneFlagPersist = true;
              this.debouncedSave();
            });
          });
        } else if (spec?.manualGustiness) {
          range.addEventListener('input', () => {
            if (this._suppressLiveWeatherDomEvents) return;
            const idx = Math.round(range.valueAsNumber);
            this._handleFadeAwareFaderInput(pid, idx, () => {});
          });
          range.addEventListener('change', () => {
            if (this._suppressLiveWeatherDomEvents) return;
            const idx = Math.round(range.valueAsNumber);
            this._handleFadeAwareFaderChange(pid, idx, () => {});
          });
        } else {
          range.addEventListener('input', () => {
            if (this._suppressLiveWeatherDomEvents) return;
            const v = range.valueAsNumber;
            if (!Number.isFinite(v)) return;
            this._handleFadeAwareFaderInput(pid, v, (val) => this._commitLiveWeatherOverrideScalar(pid, val, { save: false }));
          });
          range.addEventListener('change', () => {
            if (this._suppressLiveWeatherDomEvents) return;
            const v = range.valueAsNumber;
            if (!Number.isFinite(v)) return;
            this._handleFadeAwareFaderChange(pid, v, (val) => {
              this._commitLiveWeatherOverrideScalar(pid, val, { save: false });
              this._skipNextControlStateSceneFlagPersist = true;
              this.debouncedSave();
            });
          });
        }
      },
    });

    const rows = board.rows;

    const ashRow = rows.ashIntensity;
    if (ashRow?.faderEl) {
      ashRow.faderEl.dataset.msAshMaster = '1';
      ashRow.faderEl.style.display = isAnyAshSystemEnabledInScene() ? '' : 'none';
      if (ashRow.iconEl) {
        ashRow.iconEl.style.display = isAnyAshSystemEnabledInScene() ? '' : 'none';
      }
    }

    this._liveWeatherOverrideDom = { root: board.root, rows };
    this._liveWeatherOverrideDomBuilt = true;

    try {
      hydrateControlPanelLiveOverridesFromController(resolveWeatherController());
    } catch (_) {}
    syncControlStateFromAtmosphericFogEffect(this.controlState);
    syncAtmosphericFogEffectFromControlState(this.controlState);
    this.syncLiveWeatherOverrideDomFromDirectedPreset();
    this.syncManualFogDomFromControlState();
    this.syncLiveLightningDomFromControlState();
    this.syncManualAshDomFromController();
    this.refreshAshMasterRowVisibility();
    syncWeatherLightningEffectFromControlState(this.controlState);
  }

  _forceDirectedCustomWeatherMode() {
    const wc = resolveWeatherController();
    this.controlState.weatherMode = 'directed';
    this.controlState.dynamicEnabled = false;
    this.controlState.directedPresetId = 'Custom';

    if (wc) {
      if (typeof wc.setDynamicEnabled === 'function') wc.setDynamicEnabled(false);
      else if (typeof wc.dynamicEnabled !== 'undefined') wc.dynamicEnabled = false;
      if (typeof wc.enabled !== 'undefined') wc.enabled = true;
    }

    const eff = window.MapShine?.uiManager?.effectFolders?.weather;
    if (eff?.params && Object.prototype.hasOwnProperty.call(eff.params, 'dynamicEnabled')) {
      eff.params.dynamicEnabled = false;
      try {
        eff.bindings?.dynamicEnabled?.refresh?.();
      } catch (_) {}
    }
  }

  async _applyRapidWeatherOverrides() {
    if (this._applyingRapidOverrides) return;
    this._applyingRapidOverrides = true;
    this._ensureDirectedCustomPreset();

    try {
      const weatherController = resolveWeatherController();
      if (!weatherController) {
        log.warn('WeatherController not available for rapid weather overrides');
        return;
      }

      // Cloud/Water V2 only treat WeatherController as authoritative after init.
      // Ensure rapid overrides affect runtime state in all startup orders.
      if (weatherController.initialized !== true && typeof weatherController.initialize === 'function') {
        await weatherController.initialize();
      }

      this.controlState.weatherMode = 'directed';
      this.controlState.dynamicEnabled = false;
      this.controlState.directedPresetId = 'Custom';

      if (typeof weatherController.setDynamicEnabled === 'function') {
        weatherController.setDynamicEnabled(false);
      } else if (typeof weatherController.dynamicEnabled !== 'undefined') {
        weatherController.dynamicEnabled = false;
      }
      if (typeof weatherController.enabled !== 'undefined') {
        weatherController.enabled = true;
      }

      const clamp01 = (v) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return 0.0;
        return Math.max(0.0, Math.min(1.0, n));
      };

      const custom = this.controlState.directedCustomPreset;
      const precipitation = clamp01(custom.precipitation);
      const cloudCover = clamp01(custom.cloudCover);
      const freezeLevel = clamp01(custom.freezeLevel);
      const windSpeed = clamp01(custom.windSpeed);
      const windDirRaw = Number(custom.windDirection);
      const windDir = Number.isFinite(windDirRaw)
        ? ((windDirRaw % 360) + 360) % 360
        : 0.0;

      custom.precipitation = precipitation;
      custom.cloudCover = cloudCover;
      custom.freezeLevel = freezeLevel;
      custom.windSpeed = windSpeed;
      custom.windDirection = windDir;

      /* Also sync controlState wind fields so the Wind section stays in sync */
      this.controlState.windSpeedMS = windSpeed * 78;
      this.controlState.windDirection = windDir;

      applyDirectedCustomPresetToWeather(weatherController, custom, { syncMainTweakpane: true });

      // Keep fingerprint in sync when Live Overrides run so a subsequent time-only
      // _applyControlState does not redundantly re-apply (or re-clobber snapshot).
      this._lastWeatherControlFingerprint = this._weatherControlFingerprint();

      this._updateWeatherControls();
      this.syncLiveWeatherOverrideDomFromDirectedPreset();
      this._mirrorAllDomFromState();
    } catch (error) {
      log.error('Failed to apply rapid weather overrides:', error);
    } finally {
      this._applyingRapidOverrides = false;
    }
  }

  _buildStatusPanel(mountEl = null) {
    if (!mountEl) return null;
    if (this.statusPanel) return this.statusPanel;

    const panel = document.createElement('div');
    panel.classList.add('map-shine-time-status-panel', 'msa-cp-weather-status-panel');

    /* Top row: mode badge + activity description (director view) */
    const topRow = document.createElement('div');
    topRow.className = 'msa-cp-weather-status__top';

    const modeText = document.createElement('span');
    modeText.className = 'ms-status-mode-badge ms-status-mode-badge--off';

    const activityText = document.createElement('span');
    activityText.className = 'msa-cp-weather-status__activity';

    topRow.appendChild(modeText);
    topRow.appendChild(activityText);
    panel.appendChild(topRow);

    /* Compact single-line readout (manual view) */
    const compactText = document.createElement('div');
    compactText.className = 'msa-cp-weather-status__compact';
    panel.appendChild(compactText);

    /* Stats row: current | target — director view */
    const statsRow = document.createElement('div');
    statsRow.className = 'msa-cp-weather-status__stats';

    const curText = document.createElement('span');
    curText.className = 'msa-cp-weather-status__cur';

    const tgtText = document.createElement('span');
    tgtText.className = 'msa-cp-weather-status__tgt';

    const scopeText = document.createElement('span');
    scopeText.style.display = 'none';

    statsRow.appendChild(curText);
    statsRow.appendChild(tgtText);
    panel.appendChild(statsRow);

    /* Slim progress bar — hidden when not transitioning */
    const progressWrap = document.createElement('div');
    progressWrap.className = 'msa-cp-weather-status__progress';

    const progressMeta = document.createElement('div');
    progressMeta.className = 'msa-cp-weather-status__progress-meta';

    const progressLabel = document.createElement('span');
    const progressPct = document.createElement('span');
    progressMeta.appendChild(progressLabel);
    progressMeta.appendChild(progressPct);

    const barOuter = document.createElement('div');
    barOuter.className = 'msa-cp-weather-status__bar-outer';

    const barInner = document.createElement('div');
    barInner.className = 'msa-cp-weather-status__bar-inner';
    barOuter.appendChild(barInner);

    progressWrap.appendChild(progressMeta);
    progressWrap.appendChild(barOuter);
    panel.appendChild(progressWrap);

    this.statusPanel = panel;
    this._statusEls = {
      curText,
      tgtText,
      compactText,
      modeText,
      activityText,
      scopeText,
      progressLabel,
      progressPct,
      barInner,
      progressWrap,
      topRow,
      statsRow,
    };

    this._updateStatusPanel();
    mountEl.appendChild(panel);
    return panel;
  }

  _loadControlPanelUIState() {
    try {
      const raw = localStorage.getItem(this._uiStateStorageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  _readPx(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') return null;
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }

  _saveControlPanelUIState() {
    try {
      const state = {
        minimized: this._isMinimized === true,
        left: null,
        top: null
      };

      if (this._isMinimized && this._minimizedDock) {
        state.left = this._readPx(this._minimizedDock.style.left);
        state.top = this._readPx(this._minimizedDock.style.top);
      } else if (this.container) {
        state.left = this._readPx(this.container.style.left);
        state.top = this._readPx(this.container.style.top);
      }

      localStorage.setItem(this._uiStateStorageKey, JSON.stringify(state));
    } catch (_) {
    }
  }

  _applyControlPanelUIState(state) {
    if (!state || !this.container) return;

    const left = this._readPx(state.left);
    const top = this._readPx(state.top);

    if (Number.isFinite(left) && Number.isFinite(top)) {
      this.container.style.transform = 'none';
      this.container.style.left = `${left}px`;
      this.container.style.top = `${top}px`;
    }

    if (state.minimized === true && isGmLike()) {
      const x = Number.isFinite(left) ? left : 20;
      const y = Number.isFinite(top) ? top : 20;
      this._showMinimizedDockAt(x, y);
      this._isMinimized = true;
      this._setPanelDomVisible(false);
      this.visible = false;
    }
  }

  _createMinimizedDock(parentElement = document.body) {
    if (this._minimizedDock) return;

    const dock = document.createElement('div');
    dock.className = 'msa-cp__minimized-dock';
    dock.id = 'map-shine-control-panel-minimized';
    dock.hidden = true;

    const handle = document.createElement('div');
    handle.className = 'msa-cp__minimized-handle';
    handle.title = 'Drag Map Shine Control';
    handle.setAttribute('aria-label', 'Drag Map Shine Control');
    handle.innerHTML = '<span class="msa-cp__minimized-grip" aria-hidden="true"></span>';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'msa-cp__minimized-open';
    openBtn.textContent = 'Map Shine Control';
    openBtn.title = 'Open Map Shine Control Panel';

    dock.appendChild(handle);
    dock.appendChild(openBtn);
    parentElement.appendChild(dock);

    handle.addEventListener('pointerdown', this._boundHandlers.onMinimizedHandlePointerDown);
    openBtn.addEventListener('click', this._boundHandlers.onMinimizedOpenClick);

    this._minimizedDock = dock;
    this._minimizedHandle = handle;
    this._minimizedOpenBtn = openBtn;
  }

  _mountMinimizeButton() {
    const slot = this._shell?.minimizeSlot ?? this._shell?.topBar;
    if (!slot) return;

    if (this._minimizeButton?.parentElement === slot) return;
    this._minimizeButton?.remove();

    const minimizeButton = document.createElement('button');
    minimizeButton.type = 'button';
    minimizeButton.className = 'msa-cp__minimize-btn';
    minimizeButton.title = 'Minimize panel';
    minimizeButton.setAttribute('aria-label', 'Minimize Map Shine Control Panel');
    minimizeButton.textContent = '−';
    minimizeButton.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });
    minimizeButton.addEventListener('click', this._boundHandlers.onMinimizeButtonClick);
    slot.appendChild(minimizeButton);
    this._minimizeButton = minimizeButton;
  }

  _createMinimizeControls(parentElement = document.body) {
    this._createMinimizedDock(parentElement);
    this._mountMinimizeButton();
  }

  _showMinimizedDockAt(left, top) {
    if (!this._minimizedDock) return;
    const pad = 8;
    this._minimizedDock.hidden = false;
    const width = this._minimizedDock.offsetWidth || 180;
    const height = this._minimizedDock.offsetHeight || 36;
    const maxLeft = Math.max(pad, window.innerWidth - (width + pad));
    const maxTop = Math.max(pad, window.innerHeight - (height + pad));
    const x = Math.max(pad, Math.min(maxLeft, Number(left) || pad));
    const y = Math.max(pad, Math.min(maxTop, Number(top) || pad));
    this._minimizedDock.style.left = `${x}px`;
    this._minimizedDock.style.top = `${y}px`;
  }

  _hideMinimizedDock() {
    if (!this._minimizedDock) return;
    this._minimizedDock.hidden = true;
  }

  /** @param {boolean} visible */
  _setPanelDomVisible(visible) {
    if (!this.container) return;
    const show = visible === true;
    this.container.hidden = !show;
    this.container.classList.toggle('msa-cp--panel-hidden', !show);
    if (show) {
      this.container.style.removeProperty('display');
    }
  }

  _getPanelAnchorPosition() {
    if (!this.container) return { left: 20, top: 20 };
    const rect = this.container.getBoundingClientRect();
    if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.top)) {
      return { left: 20, top: 20 };
    }
    return { left: rect.left, top: rect.top };
  }

  _onMinimizeButtonClick(e) {
    e.preventDefault();
    e.stopPropagation();
    this._minimizeToDock();
  }

  _onMinimizedOpenClick(e) {
    e.preventDefault();
    e.stopPropagation();
    this.show();
  }

  _onMinimizedHandlePointerDown(e) {
    if (!this._minimizedDock || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const rect = this._minimizedDock.getBoundingClientRect();
    this._isDraggingMinimizedDock = true;
    this._minimizedDragStart = {
      mx: e.clientX,
      my: e.clientY,
      left: rect.left,
      top: rect.top
    };

    try {
      this._minimizedHandle?.setPointerCapture?.(e.pointerId);
    } catch (_) {}

    document.addEventListener('pointermove', this._boundHandlers.onMinimizedDockPointerMove, { capture: true });
    document.addEventListener('pointerup', this._boundHandlers.onMinimizedDockPointerUp, { capture: true });
    document.addEventListener('pointercancel', this._boundHandlers.onMinimizedDockPointerUp, { capture: true });
  }

  _onMinimizedDockPointerMove(e) {
    if (!this._isDraggingMinimizedDock || !this._minimizedDock || !this._minimizedDragStart) return;
    e.preventDefault();

    const dx = e.clientX - this._minimizedDragStart.mx;
    const dy = e.clientY - this._minimizedDragStart.my;
    const pad = 8;
    const width = this._minimizedDock.offsetWidth || 180;
    const height = this._minimizedDock.offsetHeight || 36;
    const maxLeft = Math.max(pad, window.innerWidth - (width + pad));
    const maxTop = Math.max(pad, window.innerHeight - (height + pad));
    const left = Math.max(pad, Math.min(maxLeft, this._minimizedDragStart.left + dx));
    const top = Math.max(pad, Math.min(maxTop, this._minimizedDragStart.top + dy));

    this._minimizedDock.style.left = `${left}px`;
    this._minimizedDock.style.top = `${top}px`;
  }

  _onMinimizedDockPointerUp(e) {
    if (!this._isDraggingMinimizedDock) return;

    this._isDraggingMinimizedDock = false;
    this._minimizedDragStart = null;

    try {
      this._minimizedHandle?.releasePointerCapture?.(e.pointerId);
    } catch (_) {}

    document.removeEventListener('pointermove', this._boundHandlers.onMinimizedDockPointerMove, { capture: true });
    document.removeEventListener('pointerup', this._boundHandlers.onMinimizedDockPointerUp, { capture: true });
    document.removeEventListener('pointercancel', this._boundHandlers.onMinimizedDockPointerUp, { capture: true });

    this._saveControlPanelUIState();
  }

  _minimizeToDock() {
    if (!this.container) return;

    const anchor = this._getPanelAnchorPosition();
    this._setPanelDomVisible(false);
    this.visible = false;
    this._isMinimized = true;
    this._showMinimizedDockAt(anchor.left, anchor.top);

    if (this._statusIntervalId) {
      clearInterval(this._statusIntervalId);
      this._statusIntervalId = null;
    }

    this._saveControlPanelUIState();
  }

  _finalizeGmPanelVisibility() {
    if (!isGmLike()) return;

    if (this._isMinimized) {
      const left = this._readPx(this._minimizedDock?.style?.left);
      const top = this._readPx(this._minimizedDock?.style?.top);
      this._showMinimizedDockAt(left ?? 20, top ?? 20);
      return;
    }

    this.show();
  }

  _formatWeatherLine(state) {
    if (!state) return '—';
    const pct = (v) => `${Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 100)}%`;
    const windMS = (() => {
      const ws = Number(state.windSpeed);
      return (Number.isFinite(ws) && ws > 0.01) ? ws * 78 : (Number(state.windSpeedMS) || 0);
    })();
    const freeze = Math.max(0, Math.min(1, Number(state.freezeLevel) || 0));
    const precipPct = pct(state.precipitation);
    const tempLabel = freeze > 0.75 ? 'Snow' : freeze > 0.45 ? 'Sleet' : 'Rain';
    return `${tempLabel} ${precipPct} · Clouds ${pct(state.cloudCover)} · Wind ${Math.round(windMS)}m/s`;
  }

  _updateStatusPanel() {
    const els = this._statusEls;
    if (!els) return;

    const uiMode = this._normalizeWeatherUIMode();
    const wc = coreWeatherController || window.MapShine?.weatherController || window.weatherController;
    const isGM = isGmLike();
    els.scopeText.textContent = isGM ? 'Scene (GM authoritative)' : 'Runtime only';

    if (!wc) {
      els.modeText.className = 'ms-status-mode-badge ms-status-mode-badge--off';
      els.modeText.textContent = 'Unavailable';
      els.activityText.textContent = '';
      els.curText.textContent = 'WeatherController not available';
      els.tgtText.textContent = '—';
      els.compactText.textContent = 'Weather unavailable';
      els.progressWrap.style.display = 'none';
      return;
    }

    this._updateTimeUI(wc);
    this._updateWindUI(wc);
    this._syncTileMotionSpeedFromManager();
    this._dynamicWeatherDeck?.mirrorInfo?.();

    const isEnabled = wc.enabled !== false;
    const isDynamic = wc.dynamicEnabled === true;
    const isPaused = wc.dynamicPaused === true;
    const isTrans = wc.isTransitioning === true && Number(wc.transitionDuration) > 0;

    const dynamicPreset = typeof wc.dynamicPresetId === 'string' && wc.dynamicPresetId ? wc.dynamicPresetId : '—';
    const dynamicSpeed = Number.isFinite(wc.dynamicEvolutionSpeed) ? wc.dynamicEvolutionSpeed : null;

    let modeLabel;
    let modeBadgeClass;
    if (!isEnabled) {
      modeLabel = 'Disabled';
      modeBadgeClass = 'ms-status-mode-badge--off';
    } else if (isDynamic) {
      if (isPaused) modeLabel = 'Dynamic · Paused';
      else if (isTrans) modeLabel = 'Dynamic · →';
      else modeLabel = 'Dynamic';
      modeBadgeClass = 'ms-status-mode-badge--dynamic';
    } else {
      modeLabel = 'Directed';
      modeBadgeClass = 'ms-status-mode-badge--directed';
    }
    els.modeText.className = `ms-status-mode-badge ${modeBadgeClass}`;
    els.modeText.textContent = modeLabel;

    if (isEnabled && isDynamic) {
      const meta = lookupBiome(dynamicPreset);
      const spd = dynamicSpeed !== null ? `${Math.round(dynamicSpeed)}× evolution` : '';
      const traitLine = meta?.traits?.slice(0, 2).join(' · ') || '';
      els.activityText.textContent = [meta?.blurb || dynamicPreset, traitLine, spd].filter(Boolean).join(' — ');
    } else {
      els.activityText.textContent = '';
    }

    const cur = wc.getCurrentState?.() ?? wc.currentState;
    const tgt = wc.targetState;
    const weatherLine = this._formatWeatherLine(cur);

    if (!isEnabled) {
      els.compactText.textContent = 'Weather disabled';
      els.curText.textContent = 'Weather disabled';
      els.tgtText.textContent = '';
      els.tgtText.style.display = 'none';
      els.progressWrap.style.display = 'none';
      els.barInner.style.animation = 'none';
      els.barInner.style.width = '0%';
      return;
    }

    if (uiMode === 'manual' || uiMode === 'directed') {
      els.compactText.textContent = weatherLine;
      return;
    }

    /* Dynamic mode — expanded info panel */
    if (isTrans) {
      /* Show current → target during active transition */
      els.curText.textContent = this._formatWeatherLine(cur);
      els.tgtText.textContent = '→ ' + this._formatWeatherLine(tgt);
      els.tgtText.style.display = '';

      const dur = Math.max(0.0001, Number(wc.transitionDuration) || 0);
      const el = Math.max(0, Number(wc.transitionElapsed) || 0);
      const t = Math.max(0, Math.min(1, el / dur));
      const eta = Math.max(0, dur - el);

      els.progressWrap.style.display = 'block';
      els.progressLabel.textContent = `${eta.toFixed(1)}s remaining`;
      els.progressPct.textContent = `${Math.round(t * 100)}%`;
      els.barInner.style.animation = 'none';
      els.barInner.style.width = `${t * 100}%`;
      return;
    }

    if (isDynamic) {
      /* Show current state summary for dynamic mode */
      els.curText.textContent = this._formatWeatherLine(cur);
      els.tgtText.textContent = '';
      els.tgtText.style.display = 'none';
      els.progressWrap.style.display = 'block';
      els.progressLabel.textContent = isPaused ? 'Paused' : dynamicPreset;
      els.progressPct.textContent = dynamicSpeed !== null ? `${Math.round(dynamicSpeed)}×` : '';
      els.barInner.style.width = '35%';
      els.barInner.style.animation = isPaused ? 'none' : 'mapShineIndeterminate 1.15s linear infinite';
      return;
    }

    /* Directed / idle — just show current state, hide target */
    els.curText.textContent = this._formatWeatherLine(cur);
    els.tgtText.textContent = '';
    els.tgtText.style.display = 'none';
    els.progressWrap.style.display = 'none';
    els.barInner.style.animation = 'none';
    els.barInner.style.width = '0%';
  }

  _updateTimeUI(wc) {
    if (!this.clockElements?.hand || !this.clockElements?.digital) return;
    if (this.isDraggingClock) return;

    let cur = null;
    try {
      cur = wc.getCurrentTime?.() ?? wc.timeOfDay;
    } catch (e) {
      cur = wc.timeOfDay;
    }

    const currentHour = Number.isFinite(Number(cur)) ? ((Number(cur) % 24) + 24) % 24 : null;
    if (currentHour !== null) {
      this._updateClock(currentHour);
    }

    // Always keep the ghost/target hand synced to the stored control target.
    if (Number.isFinite(Number(this.controlState?.timeOfDay))) {
      this._updateClockTarget(this.controlState.timeOfDay);
    }
  }

  _registerFoundryTimeHook() {
    this._unregisterFoundryTimeHook();

    const hooksApi = globalThis?.Hooks;
    if (!hooksApi || typeof hooksApi.on !== 'function') return;

    this._worldTimeHookId = hooksApi.on('updateWorldTime', (worldTime) => {
      if (!this.controlState?.linkTimeToFoundry) return;
      if (this.isDraggingClock) return;
      void this._syncTimeFromFoundryWorldTime(worldTime, false);
    });
  }

  _unregisterFoundryTimeHook() {
    if (this._worldTimeHookId === null) return;
    const hooksApi = globalThis?.Hooks;
    if (hooksApi && typeof hooksApi.off === 'function') {
      hooksApi.off('updateWorldTime', this._worldTimeHookId);
    }
    this._worldTimeHookId = null;
  }

  async _syncTimeFromFoundryWorldTime(worldTime = game?.time?.worldTime, persist = false) {
    if (this._isApplyingFoundryTimeSync) return;

    const linkedHour = stateApplier.getHourFromWorldTime(worldTime);
    if (!Number.isFinite(linkedHour)) return;

    this._isApplyingFoundryTimeSync = true;
    try {
      this.controlState.timeOfDay = linkedHour;

      // Keep transition bookkeeping aligned so we don't immediately re-apply stale values.
      this._lastTimeTargetApplied = linkedHour;
      this._lastTimeTransitionMinutesApplied = Number(this.controlState.timeTransitionMinutes) || 0;

      this._updateClockTarget(linkedHour);
      this._updateClock(linkedHour);

      // Canonical Foundry->Map Shine application path: updates all time-driven
      // systems (including scene darkness) without writing back to game.time.
      await stateApplier.applyFoundryWorldTime(worldTime, false, true);

      if (persist) this.debouncedSave();
    } catch (error) {
      log.warn('Failed to synchronize Map Shine time from Foundry world time:', error);
    } finally {
      this._isApplyingFoundryTimeSync = false;
    }
  }

  _updateWindUI(wc) {
    if (this._astrolabe) {
      let state = null;
      try {
        state = wc.getCurrentState?.() ?? wc.currentState;
      } catch (_) {
        state = wc.currentState;
      }

      let liveSpeedMS = null;
      let gustPulse = null;
      let liveDirectionDeg = null;
      if (state) {
        const ms = Number(state?.windSpeedMS);
        if (Number.isFinite(ms)) {
          liveSpeedMS = Math.max(0.0, Math.min(78.0, ms));
        } else {
          const legacy01 = Number(state?.windSpeed);
          if (Number.isFinite(legacy01)) liveSpeedMS = Math.max(0.0, Math.min(78.0, legacy01 * 78.0));
        }

        if (state.windDirection && !this._astrolabeWindDragging) {
          liveDirectionDeg = this._windAngleDegFromController(wc, state.windDirection);
        }

        const variability = Number(state?.windVariability ?? state?.variability);
        if (Number.isFinite(variability)) gustPulse = variability;
      }

      this._mirrorWindCompassFromState(liveSpeedMS, gustPulse, liveDirectionDeg);
      return;
    }
    if (!this._windArrow && !this._windStrengthBarInner && !this._windStrengthText) return;

    let state = null;
    try {
      state = wc.getCurrentState?.() ?? wc.currentState;
    } catch (e) {
      state = wc.currentState;
    }
    if (!state) return;

    if (this._windArrow && state.windDirection) {
      const wd = state.windDirection;
      const angleRad = Math.atan2(Number(wd.y) || 0, Number(wd.x) || 0);
      const angleDeg = (angleRad * 180) / Math.PI;
      this._windArrow.style.transform = `translate(-50%, 0%) rotate(${90 - angleDeg}deg)`;
    }

    const windMS = (() => {
      const ms = Number(state?.windSpeedMS);
      if (Number.isFinite(ms)) return Math.max(0.0, Math.min(78.0, ms));
      const legacy01 = Number(state?.windSpeed);
      if (Number.isFinite(legacy01)) return Math.max(0.0, Math.min(78.0, legacy01 * 78.0));
      return 0.0;
    })();
    const wind01 = Math.max(0.0, Math.min(1.0, windMS / 78.0));
    const label = `${windMS.toFixed(1)} m/s`;
    this._setFolderTag('wind', label);

    if (this._windStrengthBarInner) {
      this._windStrengthBarInner.style.width = `${wind01 * 100}%`;
    }
    if (this._windStrengthText) {
      this._windStrengthText.textContent = label;
    }
  }

  _getCurrentSceneHour() {
    try {
      const wc = coreWeatherController || window.MapShine?.weatherController;
      const cur = wc?.getCurrentTime?.() ?? wc?.timeOfDay;
      if (Number.isFinite(Number(cur))) return ((Number(cur) % 24) + 24) % 24;
    } catch (_) {}
    const cs = Number(this.controlState?.timeOfDay);
    return Number.isFinite(cs) ? ((cs % 24) + 24) % 24 : 12;
  }

  _getEnvironmentFadeMinutes() {
    return Number(this.controlState.timeTransitionMinutes) || 0;
  }

  _isEnvironmentFadeEnabled() {
    return this._getEnvironmentFadeMinutes() > 0;
  }

  _ensureEnvironmentFadePreviewStart() {
    if (this._environmentFadePreviewStartSnap) return;
    this._environmentFadePreviewStartSnap = environmentControlApi.captureSnapshot();
    this._environmentFadePreviewStartExtras = fadeExtrasFromControlState(
      this.controlState,
      readAshIntensityFromController(),
    );
    this._syncFaderLiveValuesFromSnapshot(this._environmentFadePreviewStartSnap);
  }

  _clearEnvironmentFadePreviewSession() {
    this._environmentFadePreviewStartSnap = null;
    this._environmentFadePreviewStartExtras = null;
    this._pendingWindTarget = null;
    clearAllFaderPreviews(this._liveWeatherOverrideDom?.rows);
    this._astrolabe?.clearWindTargetPreview?.();
  }

  /**
   * @param {import('./environment-control-api.js').EnvironmentSnapshot} snap
   * @private
   */
  _syncFaderLiveValuesFromSnapshot(snap) {
    const rows = this._liveWeatherOverrideDom?.rows;
    if (!rows || !snap) return;
    const w = snap.weather || {};
    setFaderLiveValue(rows, 'precipitation', w.precipitation);
    setFaderLiveValue(rows, 'cloudCover', w.cloudCover);
    setFaderLiveValue(rows, 'freezeLevel', w.freezeLevel);
    setFaderLiveValue(rows, 'manualFogDensity', snap.manualFogDensity);
    setFaderLiveValue(rows, 'lightning', snap.lightning);
    if (this._environmentFadePreviewStartExtras) {
      setFaderLiveValue(rows, 'ashIntensity', this._environmentFadePreviewStartExtras.ashIntensity);
      setFaderLiveValue(rows, 'gustiness', this._environmentFadePreviewStartExtras.gustinessIndex ?? 2);
    }
  }

  /**
   * @param {import('./environment-control-api.js').EnvironmentSnapshot} snap
   * @param {import('./environment-fade-controller.js').FadeExtras} extras
   * @private
   */
  _syncPanelUiFromFadeSnapshot(snap, extras) {
    if (!snap) return;
    this._updateClock(snap.timeOfDay);
    this._mirrorWindCompassFromState(
      snap.weather.windSpeed * MAX_WIND_MS_CP,
      null,
      snap.weather.windDirection,
    );
    if (this._liveWeatherOverrideDom?.rows) {
      const rows = this._liveWeatherOverrideDom.rows;
      mirrorFaderRow(rows, 'precipitation', snap.weather.precipitation);
      mirrorFaderRow(rows, 'cloudCover', snap.weather.cloudCover);
      mirrorFaderRow(rows, 'freezeLevel', snap.weather.freezeLevel);
      mirrorFaderRow(rows, 'manualFogDensity', snap.manualFogDensity);
      mirrorFaderRow(rows, 'lightning', snap.lightning);
      mirrorFaderRow(rows, 'ashIntensity', extras?.ashIntensity ?? 0);
      mirrorFaderRow(rows, 'gustiness', Math.round(extras?.gustinessIndex ?? 2));
    }
  }

  /**
   * @param {import('./environment-fade-controller.js').FadeExtras} extras
   * @param {boolean} last
   * @private
   */
  async _applyFadeExtras(extras, last) {
    const gust = gustinessFromExtras(extras);
    if (this.controlState.gustiness !== gust) {
      this.controlState.gustiness = gust;
      this._coercePanelWindScalarsInPlace();
    }
    try {
      const wc = resolveWeatherController();
      const variability = GUSTINESS_TO_VARIABILITY[gust] ?? GUSTINESS_TO_VARIABILITY.moderate;
      if (typeof wc?.setVariability === 'function') {
        wc.setVariability(variability);
      } else if (wc) {
        wc.variability = Math.max(0, Math.min(1, variability));
      }
    } catch (_) {}
    try {
      applyAshMasterIntensity(extras.ashIntensity, { syncMainTweakpane: last });
    } catch (_) {}
    if (last) {
      void this._applyWindState();
    }
  }

  /**
   * @param {import('./environment-control-api.js').EnvironmentSnapshot} endSnap
   * @param {number} [transitionMinutes]
   * @param {import('./environment-control-api.js').EnvironmentSnapshot} [startSnap]
   * @param {import('./environment-fade-controller.js').FadeExtras} [startExtras]
   * @param {import('./environment-fade-controller.js').FadeExtras} [endExtras]
   * @private
   */
  async _startEnvironmentTransition(endSnap, transitionMinutes, startSnap, startExtras, endExtras) {
    const start = startSnap || this._environmentFadePreviewStartSnap || environmentControlApi.captureSnapshot();
    const startEx = startExtras || this._environmentFadePreviewStartExtras || fadeExtrasFromControlState(this.controlState);
    const endEx = endExtras || fadeExtrasFromControlState(this.controlState, startEx.ashIntensity);
    const mins = Number.isFinite(Number(transitionMinutes))
      ? Number(transitionMinutes)
      : this._getEnvironmentFadeMinutes();

    if (stateApplier._timeTransitionIntervalId) {
      clearInterval(stateApplier._timeTransitionIntervalId);
      stateApplier._timeTransitionIntervalId = null;
    }

    this._environmentFadeTransitionActive = true;
    this._clearEnvironmentFadePreviewSession();
    this._revealTimeTargetUI();
    this._updateClockTarget(endSnap.timeOfDay);
    this._astrolabe?.setWindTargetPreview?.(
      endSnap.weather.windDirection,
      endSnap.weather.windSpeed * MAX_WIND_MS_CP,
    );

    try {
      await environmentFadeController.start(start, endSnap, startEx, endEx, mins, {
        onTick: (snap, extras) => {
          this._syncPanelUiFromFadeSnapshot(snap, extras);
        },
        applyExtras: (extras, last) => this._applyFadeExtras(extras, last),
      });

      this.controlState.timeOfDay = endSnap.timeOfDay;
      this._ensureDirectedCustomPreset();
      Object.assign(this.controlState.directedCustomPreset, endSnap.weather);
      this.controlState.windSpeedMS = endSnap.weather.windSpeed * MAX_WIND_MS_CP;
      this.controlState.windDirection = endSnap.weather.windDirection;
      writeManualFogDensityToControlState(this.controlState, endSnap.manualFogDensity);
      writeLightningIntensityToControlState(this.controlState, endSnap.lightning);
      this._coercePanelWindScalarsInPlace();
      this._lastTimeTargetApplied = endSnap.timeOfDay;
      this._lastTimeTransitionMinutesApplied = mins;
      this._mirrorAllDomFromState();
      this._astrolabe?.clearWindTargetPreview?.();
    } finally {
      this._environmentFadeTransitionActive = false;
    }
  }

  /** @private */
  async _commitEnvironmentFadeFromControlState() {
    const endSnap = snapshotFromControlState(this.controlState, MAX_WIND_MS_CP);
    await this._startEnvironmentTransition(
      endSnap,
      this._getEnvironmentFadeMinutes(),
      this._environmentFadePreviewStartSnap,
      this._environmentFadePreviewStartExtras,
      fadeExtrasFromControlState(this.controlState),
    );
  }

  /**
   * @param {string} paramId
   * @param {number} value
   * @private
   */
  _retargetEnvironmentFadeChannel(paramId, value, resetClock = false) {
    const mins = this._getEnvironmentFadeMinutes();
    if (mins <= 0) return;
    environmentFadeController.retargetChannel(
      /** @type {import('./environment-fade-controller.js').FadeChannelId} */ (paramId),
      value,
      mins,
      { resetClock },
    );
  }

  /**
   * @param {string} paramId
   * @param {number} value
   * @param {(v: number) => void} commitFn
   * @private
   */
  _handleFadeAwareFaderInput(paramId, value, commitFn) {
    const fadeMins = this._getEnvironmentFadeMinutes();

    if (environmentFadeController.isRunning && fadeMins > 0) {
      if (paramId === 'gustiness') {
        this.controlState.gustiness = GUSTINESS_LABELS[Math.round(value)] || 'moderate';
      } else {
        commitFn(value);
      }
      if (!this._fadeChannelDragActive.has(paramId)) {
        this._retargetEnvironmentFadeChannel(paramId, value, true);
        this._fadeChannelDragActive.add(paramId);
      } else {
        this._retargetEnvironmentFadeChannel(paramId, value, false);
      }
      return;
    }

    if (!this._isEnvironmentFadeEnabled() || this._environmentFadeTransitionActive) {
      commitFn(value);
      return;
    }
    this._ensureEnvironmentFadePreviewStart();
    setFaderPreview(this._liveWeatherOverrideDom?.rows, paramId, value);
  }

  /**
   * @param {string} paramId
   * @param {number} value
   * @param {(v: number) => void} commitFn
   * @private
   */
  _handleFadeAwareFaderChange(paramId, value, commitFn) {
    this._fadeChannelDragActive.delete(paramId);
    const fadeMins = this._getEnvironmentFadeMinutes();

    if (environmentFadeController.isRunning && fadeMins > 0) {
      if (paramId === 'gustiness') {
        this.controlState.gustiness = GUSTINESS_LABELS[Math.round(value)] || 'moderate';
      } else {
        commitFn(value);
      }
      this._retargetEnvironmentFadeChannel(paramId, value, false);
      this.debouncedSave();
      return;
    }

    if (!this._isEnvironmentFadeEnabled() || this._environmentFadeTransitionActive) {
      commitFn(value);
      return;
    }
    if (paramId !== 'gustiness') {
      commitFn(value);
    } else {
      this.controlState.gustiness = GUSTINESS_LABELS[Math.round(value)] || 'moderate';
    }
    void this._commitEnvironmentFadeFromControlState().then(() => this.debouncedSave());
  }

  /** @private */
  _updateWindPreviewDuringFade() {
    const start = this._environmentFadePreviewStartSnap;
    const pending = this._pendingWindTarget;
    if (!start || !pending) return;
    const liveSpeed = start.weather.windSpeed * MAX_WIND_MS_CP;
    const liveDir = start.weather.windDirection;
    this._astrolabe?.mirror?.({
      speedMS: liveSpeed,
      directionDeg: liveDir,
      gustiness: this.controlState.gustiness,
    });
    this._astrolabe?.setWindTargetPreview?.(
      Number.isFinite(pending.directionDeg) ? pending.directionDeg : liveDir,
      Number.isFinite(pending.speedMS) ? pending.speedMS : liveSpeed,
    );
  }

  async _startTimeOfDayTransition(targetHour, transitionMinutes, startHour = null) {
    try {
      const tgt = ((Number(targetHour) % 24) + 24) % 24;
      this.controlState.timeOfDay = tgt;

      const startSnap = environmentControlApi.captureSnapshot();
      if (Number.isFinite(Number(startHour))) {
        startSnap.timeOfDay = ((Number(startHour) % 24) + 24) % 24;
      }
      const endSnap = snapshotFromControlState(this.controlState, MAX_WIND_MS_CP);
      endSnap.timeOfDay = tgt;

      await this._startEnvironmentTransition(
        endSnap,
        transitionMinutes,
        startSnap,
        fadeExtrasFromControlState(this.controlState),
        fadeExtrasFromControlState(this.controlState),
      );
    } catch (error) {
      log.error('Failed to start time-of-day transition:', error);
      ui.notifications?.error('Failed to start time transition');
    }
  }

  /**
   * Initialize the Control Panel
   * @param {HTMLElement} [parentElement] - Optional parent element (defaults to body)
   * @returns {Promise<void>}
   */
  async initialize(parentElement = document.body) {
    if (this._shell) {
      log.warn('ControlPanelManager already initialized');
      return;
    }

    const _dlp = debugLoadingProfiler;
    const _isDbg = _dlp.debugMode;

    log.info('Initializing Control Panel...');

    this._injectPanelStyles();

    this.container = document.createElement('div');
    this.container.id = 'map-shine-control-panel';
    this.container.style.position = 'fixed';
    this.container.style.zIndex = '9999';
    this.container.style.left = '50%';
    this.container.style.top = '50%';
    this.container.style.transform = 'translate(-50%, -50%)';
    this.container.hidden = true;
    this.container.classList.add('msa-cp--panel-hidden');
    this.container.style.width = `${CP_PANEL_WIDTH_PX}px`;
    this.container.style.maxWidth = `${CP_PANEL_WIDTH_PX}px`;
    parentElement.appendChild(this.container);

    {
      const stop = (e) => {
        try { e.stopPropagation(); } catch (_) {}
      };
      const stopAndPrevent = (e) => {
        try { e.preventDefault(); } catch (_) {}
        stop(e);
      };
      for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick', 'wheel']) {
        if (type === 'wheel') this.container.addEventListener(type, stop, { passive: true });
        else this.container.addEventListener(type, stop);
      }
      this.container.addEventListener('contextmenu', stopAndPrevent);
    }

    this._shell = createControlPanelShell(this.container);
    this.headerOverlay = this._shell.headChrome;
    this.headerOverlay.addEventListener('mousedown', this._boundHandlers.onHeaderMouseDown);

    this._createMinimizedDock(parentElement);

    const savedUiState = this._loadControlPanelUIState();

    // Load saved control state
    if (_isDbg) _dlp.begin('cp.loadControlState', 'finalize');
    this._didLoadControlState = await this._loadControlState();
    if (_isDbg) _dlp.end('cp.loadControlState');

    // `weather-snapshot` is the latest live-play authority. Some Control Panel edits
    // intentionally skip `controlState` flag writes (V14 redraw guard), so the snapshot
    // carries a full sanitized controlState copy to prevent stale flags from clobbering it.
    try {
      const snap = canvas?.scene?.getFlag?.('map-shine-advanced', 'weather-snapshot');
      if (snap && typeof snap === 'object') {
        if (snap.controlState && typeof snap.controlState === 'object' && !Array.isArray(snap.controlState)) {
          Object.assign(this.controlState, cloneAndSanitizeControlState(snap.controlState, { silent: true }));
          this._ensureDirectedCustomPreset();
          this._didLoadControlState = true;
          this._suppressInitialWeatherApply = true;
        }
        if (Number.isFinite(snap.timeOfDay)) {
          this.controlState.timeOfDay = snap.timeOfDay % 24;
        }
        if (typeof snap.linkTimeToFoundry === 'boolean') {
          this.controlState.linkTimeToFoundry = snap.linkTimeToFoundry;
        }
        const tt = Number(snap.timeTransitionMinutes);
        if (Number.isFinite(tt)) {
          this.controlState.timeTransitionMinutes = tt;
        }
      }
    } catch (_) {}

    // If Foundry link mode is enabled, pull canonical world time before first apply pass.
    if (this.controlState.linkTimeToFoundry) {
      const linkedHour = stateApplier.getHourFromWorldTime(game?.time?.worldTime);
      if (Number.isFinite(linkedHour)) {
        this.controlState.timeOfDay = linkedHour;
      }
    }

    // If tile motion already has persisted global state, mirror speed into control UI.
    this._syncTileMotionSpeedFromManager();

    try {
      // Only use the weather snapshot as a fallback when no controlState is present.
      // controlState is the authoritative live-play state and should win on refresh.
      if (!this._didLoadControlState) {
        const snap = canvas?.scene?.getFlag?.('map-shine-advanced', 'weather-snapshot');
        if (snap && typeof snap === 'object') {
          if (typeof snap.dynamicEnabled === 'boolean') {
            this.controlState.dynamicEnabled = snap.dynamicEnabled === true;
            this.controlState.weatherMode = snap.dynamicEnabled === true ? 'dynamic' : 'directed';
          }
          if (typeof snap.dynamicPresetId === 'string' && snap.dynamicPresetId) {
            this.controlState.dynamicPresetId = snap.dynamicPresetId;
          }
          if (Number.isFinite(snap.dynamicEvolutionSpeed)) {
            this.controlState.dynamicEvolutionSpeed = snap.dynamicEvolutionSpeed;
          }
          if (typeof snap.dynamicPaused === 'boolean') {
            this.controlState.dynamicPaused = snap.dynamicPaused === true;
          }
          if (Number.isFinite(snap.timeOfDay)) {
            this.controlState.timeOfDay = snap.timeOfDay % 24;
          }

          this._suppressInitialWeatherApply = true;
        }
      }
    } catch (e) {
    }

    this._sanitizeControlStateForTweakpaneBindings();
    inferWeatherPanelView(this.controlState);

    // Build UI sections
    if (_isDbg) _dlp.begin('cp.buildSections', 'finalize');
    this._buildPhaseALayout();
    if (_isDbg) _dlp.end('cp.buildSections');
    this._applyWeatherPanelViewVisibility();

    // Apply initial state
    if (_isDbg) _dlp.begin('cp.applyControlState', 'finalize');
    await this._applyControlState();
    if (_isDbg) _dlp.end('cp.applyControlState');

    try {
      resolveWeatherController()?._loadDynamicStateFromScene?.();
      this._dynamicWeatherDeck?.mirror?.();
    } catch (_) {}

    try {
      hydrateControlPanelLiveOverridesFromController(resolveWeatherController());
      this.syncLiveWeatherOverrideDomFromDirectedPreset();
    } catch (_) {}

    this._syncLandscapeLightningAndFogFromControlState();
    void this._applyWindState();

    this._registerFoundryTimeHook();

    this._applyControlPanelUIState(savedUiState);
    this._finalizeGmPanelVisibility();

    // Ash effect UI registers after the panel shell; re-check once effects + scene are ready.
    queueMicrotask(() => {
      try {
        this._wireLiveWeatherOverrideBindingsIfReady();
        this.refreshAshMasterRowVisibility();
      } catch (_) {}
    });
    setTimeout(() => {
      try {
        this.refreshAshMasterRowVisibility();
      } catch (_) {}
    }, 500);

    log.info('Control Panel initialized');
  }

  _buildQuickSceneBeatsSection(parentFolder = this.pane, options = undefined) {
    const targetFolder = parentFolder || this.pane;
    const beatsFolder = targetFolder.addFolder({
      title: options?.title ?? '⚡ Weather Presets',
      expanded: options?.expanded ?? true
    });
    if (options?.registerTopLevel !== false && targetFolder === this.pane) this._registerTopLevelFolder(beatsFolder);
    this._ensureFolderTag(beatsFolder, 'quick', 'Quick');

    const contentElement = beatsFolder.element.querySelector('.tp-fldv_c') || beatsFolder.element;

    const makeBtn = (label, onClick) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.style.cssText = [
        'padding:5px 4px',
        'border-radius:5px',
        'border:1px solid rgba(255,255,255,0.12)',
        'background:rgba(255,255,255,0.06)',
        'color:rgba(210,232,255,0.90)',
        'cursor:pointer',
        'font-size:9.5px',
        'font-weight:600',
        'font-family:inherit',
        'transition:background 0.12s,border-color 0.12s'
      ].join(';');
      btn.addEventListener('mouseenter', () => {
        btn.style.background = 'rgba(80,170,255,0.14)';
        btn.style.borderColor = 'rgba(80,170,255,0.32)';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.background = 'rgba(255,255,255,0.06)';
        btn.style.borderColor = 'rgba(255,255,255,0.12)';
      });
      btn.addEventListener('click', onClick);
      return btn;
    };

    /* Compact 2×2 weather preset grid with theme-consistent padding */
    const weatherGrid = document.createElement('div');
    weatherGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:3px;padding:5px 6px 5px;';

    const weatherBeats = {
      'Clear ☀️': 'Clear (Dry)',
      'Rain 🌧️': 'Rain',
      'Storm ⛈️': 'Thunderstorm',
      'Snow ❄️': 'Snow'
    };
    for (const [label, presetId] of Object.entries(weatherBeats)) {
      weatherGrid.appendChild(makeBtn(label, () => {
        void this._applyQuickWeatherBeat(presetId).then(() => this.debouncedSave());
      }));
    }
    contentElement.appendChild(weatherGrid);
  }

  async _applyQuickWeatherBeat(presetId) {
    this.controlState.weatherMode = 'directed';
    this.controlState.dynamicEnabled = false;
    this.controlState.directedPresetId = presetId;

    this._updateWeatherControls();
    this._mirrorAllDomFromState();

    await this._startDirectedTransition();
  }

  _buildEnvironmentSection(parentFolder = this.pane, options = undefined) {
    const targetFolder = parentFolder || this.pane;
    const envFolder = targetFolder.addFolder({
      title: options?.title ?? '🌤️ Environment',
      expanded: options?.expanded ?? false
    });
    if (options?.registerTopLevel !== false && targetFolder === this.pane) this._registerTopLevelFolder(envFolder);
    this._ensureFolderTag(envFolder, 'environment', 'Sun');

    // Initialize from the shared config panel state if available.
    try {
      const lat = window.MapShine?.uiManager?.globalParams?.sunLatitude;
      if (typeof lat === 'number' && Number.isFinite(lat)) {
        this._environmentState.sunLatitude = lat;
      }
    } catch (e) {
    }

    const onSunLatitudeChange = (ev) => {
      this._environmentState.sunLatitude = ev.value;

      const uiManager = window.MapShine?.uiManager;
      if (uiManager?.globalParams) {
        uiManager.globalParams.sunLatitude = ev.value;
        if (typeof uiManager.onGlobalChange === 'function') {
          uiManager.onGlobalChange('sunLatitude', ev.value);
        }
        try {
          uiManager._sunLatitudeBinding?.refresh?.();
        } catch (e) {
        }
      }
    };

    this._sunLatitudeBinding = envFolder.addBinding(this._environmentState, 'sunLatitude', {
      label: 'Sun Latitude',
      min: 0.0,
      max: 1.0,
      step: 0.01
    }).on('change', onSunLatitudeChange);
  }

  _startEnvironmentSync() {
    if (this._sunLatitudeSyncIntervalId !== null) {
      clearInterval(this._sunLatitudeSyncIntervalId);
      this._sunLatitudeSyncIntervalId = null;
    }

    // P3: Reduced from 200ms to 2000ms. Sun latitude changes infrequently
    // (only when map maker edits it or time-link updates it). The old 200ms
    // interval created 5 wakeups/sec of main-thread noise with no visible
    // benefit. 2s is more than responsive enough for a UI sync.
    let lastLat = null;
    this._sunLatitudeSyncIntervalId = setInterval(() => {
      try {
        const uiManager = window.MapShine?.uiManager;
        const lat = uiManager?.globalParams?.sunLatitude;
        if (typeof lat !== 'number' || !Number.isFinite(lat)) return;
        if (lastLat === null) lastLat = lat;

        if (lat !== lastLat) {
          lastLat = lat;
          this._environmentState.sunLatitude = lat;
          try {
            this._sunLatitudeBinding?.refresh?.();
          } catch (e) {
          }
        }
      } catch (e) {
      }
    }, 2000);
  }

  /**
   * @returns {Array<{ label: string, hour: number, clockHint: string }>}
   * @private
   */
  _resolveTodQuickPickAnchors() {
    return resolveTodQuickPickAnchors(readColorCorrectionParamsFromUi());
  }

  /**
   * Combined Time + Wind Astrolabe — fills the remote head.
   * @param {HTMLElement} mountEl
   * @private
   */
  _buildAstrolabeHero(mountEl) {
    const refreshTimeFolderTag = () => {
      const mins = Number(this.controlState.timeTransitionMinutes) || 0;
      if (this.controlState.linkTimeToFoundry) {
        this._setFolderTag('time', 'VTT Sync');
      } else if (mins > 0) {
        this._setFolderTag('time', formatFadeMinutes(mins));
      } else {
        this._setFolderTag('time', 'Now');
      }
    };
    this._refreshTimeFolderTag = refreshTimeFolderTag;

    const jumpToHour = (hour) => {
      this._revealTimeTargetUI();
      this.controlState.timeOfDay = hour;
      const mins = Number(this.controlState.timeTransitionMinutes) || 0;
      if (mins > 0) {
        this._clearEnvironmentFadePreviewSession();
        void this._startEnvironmentTransition(
          snapshotFromControlState(this.controlState, MAX_WIND_MS_CP),
          mins,
          environmentControlApi.captureSnapshot(),
          fadeExtrasFromControlState(this.controlState),
          fadeExtrasFromControlState(this.controlState),
        ).then(() => this._queueTimeOnlySave());
      } else {
        void this._setTimeOfDay(hour).then(() => this._queueTimeOnlySave());
      }
    };

    this._astrolabe = createAstrolabeDial({
      faceSize: 280,
      onTimeStopClick: jumpToHour,
      maxSpeedMS: MAX_WIND_MS_CP,
      onContextHint: (text) => {
        if (text) this._setContextHint('dial', text);
        else this._clearContextHint('dial');
      },
      onWindDragChange: (dragging) => {
        this._astrolabeWindDragging = dragging === true;
        if (dragging && this._isEnvironmentFadeEnabled()) {
          this._ensureEnvironmentFadePreviewStart();
          this._pendingWindTarget = {};
        }
        if (!dragging && this._isEnvironmentFadeEnabled() && this._pendingWindTarget) {
          if (Number.isFinite(this._pendingWindTarget.speedMS)) {
            this.controlState.windSpeedMS = this._pendingWindTarget.speedMS;
          }
          if (Number.isFinite(this._pendingWindTarget.directionDeg)) {
            this.controlState.windDirection = this._pendingWindTarget.directionDeg;
          }
          void this._commitEnvironmentFadeFromControlState().then(() => this.debouncedSave());
          this._pendingWindTarget = null;
        }
      },
      onSpeedChange: (ms, last) => {
        if (this._isEnvironmentFadeEnabled() && this._astrolabeWindDragging) {
          this._pendingWindTarget = { ...this._pendingWindTarget, speedMS: ms };
          this._updateWindPreviewDuringFade();
          return;
        }
        this.controlState.windSpeedMS = ms;
        this._coercePanelWindScalarsInPlace();
        void this._applyWindState();
        if (last) this.debouncedSave();
      },
      onDirectionChange: (deg, last) => {
        if (this._isEnvironmentFadeEnabled() && this._astrolabeWindDragging) {
          this._pendingWindTarget = { ...this._pendingWindTarget, directionDeg: deg };
          this._updateWindPreviewDuringFade();
          return;
        }
        this.controlState.windDirection = deg;
        this._coercePanelWindScalarsInPlace();
        void this._applyWindState();
        if (last) this.debouncedSave();
      },
    });

    this.clockElement = this._astrolabe.container;
    this.clockElements = this._astrolabe.elements;
    updatePhaseRing(this.clockElements.phaseRing, this.controlState.timeOfDay);

    this.clockElements.face.addEventListener('mousedown', this._boundHandlers.onFaceMouseDown);
    this.clockElements.face.addEventListener('touchstart', this._boundHandlers.onFaceTouchStart);
    if (this.clockElements.handHub) {
      this.clockElements.handHub.addEventListener('mousedown', this._boundHandlers.onFaceMouseDown);
      this.clockElements.handHub.addEventListener('touchstart', this._boundHandlers.onFaceTouchStart);
    }
    if (!this._clockDocListenersAttached) {
      document.addEventListener('mousemove', this._boundHandlers.onDocMouseMove, { capture: true });
      document.addEventListener('mouseup', this._boundHandlers.onDocMouseUp, { capture: true });
      document.addEventListener('touchmove', this._boundHandlers.onDocTouchMove);
      document.addEventListener('touchend', this._boundHandlers.onDocTouchEnd);
      this._clockDocListenersAttached = true;
    }

    mountEl.appendChild(this._astrolabe.container);
    refreshTimeFolderTag();
    this._mirrorWindCompassFromState();
    this._mirrorWeatherPresetButtons();
    this._updateClock(this.controlState.timeOfDay);
  }

  /**
   * @returns {number}
   * @private
   */
  _getTimeScalePercent() {
    const uiRate = window.MapShine?.uiManager?.globalParams?.timeRate;
    if (Number.isFinite(Number(uiRate))) {
      return Math.max(0, Math.min(200, Number(uiRate)));
    }
    const scale = window.MapShine?.timeManager?.scale;
    if (Number.isFinite(Number(scale))) {
      return Math.max(0, Math.min(200, Math.round(Number(scale) * 100)));
    }
    return 100;
  }

  /**
   * @param {number} value
   * @param {{ persist?: boolean }} [options]
   * @private
   */
  _applyTimeScale(value, options = {}) {
    const persist = options.persist !== false;
    const rate = Math.max(0, Math.min(200, Number(value) || 0));
    if (this._timeScaleParams) this._timeScaleParams.timeRate = rate;

    const ui = window.MapShine?.uiManager;
    if (ui) {
      ui.globalParams.timeRate = rate;
      ui.onGlobalChange('timeRate', rate);
      if (persist) ui.saveUIState();
    } else if (window.MapShine?.timeManager) {
      window.MapShine.timeManager.setScale(rate / 100);
    }

    try {
      this._timeScaleControl?.mirror?.(rate);
    } catch (_) {}
  }

  _syncTimeScaleBindingFromUiManager() {
    if (!this._timeScaleParams) return;
    this._timeScaleParams.timeRate = this._getTimeScalePercent();
    try {
      this._timeScaleControl?.mirror?.(this._timeScaleParams.timeRate);
    } catch (_) {}
  }

  _updateCustomTimeControls() {
    if (this._timeTransitionStepper?.mirror) {
      this._timeTransitionStepper.mirror(Number(this.controlState.timeTransitionMinutes) || 0);
    }
    if (this._foundryLockBtn) {
      const locked = this.controlState.linkTimeToFoundry === true;
      this._foundryLockBtn.classList.toggle('is-locked', locked);
      this._foundryLockBtn.textContent = locked ? '🔒 Synced to Foundry VTT' : '🔓 Sync Foundry VTT Time';
      this._foundryLockBtn.disabled = !(isGmLike());
    }
  }

  _revealTimeTargetUI() {
    if (this._didRevealTimeTarget) return;
    this._didRevealTimeTarget = true;
    if (this.clockElements?.targetHandHub) {
      this.clockElements.targetHandHub.style.display = '';
    }
  }

  _updateClockTarget(hour) {
    const hub = this.clockElements?.targetHandHub || this.clockElements?.targetHand;
    if (!hub) return;

    // Only show the ghost hand after the first user-driven target interaction.
    if (!this._didRevealTimeTarget) return;

    const shifted = ((hour - 12) % 24 + 24) % 24;
    const angle = (shifted / 24) * 360;
    hub.style.transform = `rotate(${angle}deg)`;
  }

  /**
   * Update clock hand position and digital display
   * @param {number} hour - 0-24 hour value
   * @private
   */
  _updateClock(hour) {
    const handHub = this.clockElements?.handHub || this.clockElements?.hand;
    if (!handHub) return;

    const shifted = ((hour - 12) % 24 + 24) % 24;
    const angle = (shifted / 24) * 360;
    handHub.style.transform = `rotate(${angle}deg)`;

    const displayHour = Math.floor(hour);
    const displayMinute = Math.floor((hour % 1) * 60);
    const timeText = `${displayHour.toString().padStart(2, '0')}:${displayMinute.toString().padStart(2, '0')}`;
    if (this.clockElements.digital) {
      this.clockElements.digital.textContent = timeText;
    }
    if (this._astrolabe?.setDigitalTime) {
      this._astrolabe.setDigitalTime(timeText);
    }
    if (this._astrolabe?.updateTimeVisuals) {
      this._astrolabe.updateTimeVisuals(hour);
    } else if (this.clockElements.phaseRing) {
      updatePhaseRing(this.clockElements.phaseRing, hour);
    }
  }

  _isAstrolabeNonTimeTarget(e) {
    if (e.target?.closest?.('.msa-cp-astrolabe__wind-grab, .msa-cp-astrolabe__time-stop, .msa-cp-astrolabe__weather-btn, .msa-cp-astrolabe__time-pill')) {
      return true;
    }
    return false;
  }

  /**
   * @param {MouseEvent|TouchEvent} e
   * @returns {boolean}
   * @private
   */
  _isAstrolabeTimeRingPointer(e) {
    const x = e.clientX ?? e.touches?.[0]?.clientX;
    const y = e.clientY ?? e.touches?.[0]?.clientY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (e.target?.closest?.('.msa-cp-astrolabe__handle-hub')) return true;
    return this._astrolabe?.hitTestTimeRing?.(x, y) === true;
  }

  /**
   * Handle mouse down on clock
   * @param {MouseEvent} e
   * @private
   */
  _onClockMouseDown(e) {
    if (this._astrolabeWindDragging) return;
    if (this._isAstrolabeNonTimeTarget(e)) {
      return;
    }
    if (!this._isAstrolabeTimeRingPointer(e)) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    this.isDraggingClock = true;
    this._isDraggingPanel = false;
    this._dragTimeStartHour = this._getCurrentSceneHour();
    if (this._isEnvironmentFadeEnabled()) {
      this._ensureEnvironmentFadePreviewStart();
    }
    this._revealTimeTargetUI();
    this._updateTimeFromMouse(e);
  }

  /**
   * Handle mouse move for clock dragging
   * @param {MouseEvent} e
   * @private
   */
  _onClockMouseMove(e) {
    if (!this.isDraggingClock) return;
    e.preventDefault();
    e.stopPropagation();
    this._updateTimeFromMouse(e);
  }

  /**
   * Handle mouse up
   * @private
   */
  _onClockMouseUp() {
    if (this.isDraggingClock) {
      this.isDraggingClock = false;
      this._clearContextHint('time-drag');

      const target = this._dragTimeTarget;
      this._dragTimeTarget = null;

      if (typeof target === 'number' && Number.isFinite(target)) {
        this.controlState.timeOfDay = target;
        const mins = Number(this.controlState.timeTransitionMinutes) || 0;
        this._dragTimeStartHour = null;
        if (mins > 0) {
          void this._commitEnvironmentFadeFromControlState().then(() => this._queueTimeOnlySave());
        } else {
          void this._setTimeOfDay(target).then(() => this._queueTimeOnlySave());
        }
      } else {
        this._dragTimeStartHour = null;
        this._queueTimeOnlySave();
      }
    }
  }

  /**
   * Handle touch start on clock
   * @param {TouchEvent} e
   * @private
   */
  _onClockTouchStart(e) {
    if (this._isAstrolabeNonTimeTarget(e)) {
      return;
    }
    if (!this._isAstrolabeTimeRingPointer(e)) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    this.isDraggingClock = true;
    this._isDraggingPanel = false;
    this._dragTimeStartHour = this._getCurrentSceneHour();
    if (this._isEnvironmentFadeEnabled()) {
      this._ensureEnvironmentFadePreviewStart();
    }
    this._revealTimeTargetUI();
    const touch = e.touches[0];
    this._updateTimeFromMouse(touch);
  }

  /**
   * Handle touch move for clock dragging
   * @param {TouchEvent} e
   * @private
   */
  _onClockTouchMove(e) {
    if (!this.isDraggingClock) return;
    e.preventDefault();
    const touch = e.touches[0];
    this._updateTimeFromMouse(touch);
  }

  /**
   * Update time from mouse/touch position
   * @param {MouseEvent|Touch} e
   * @private
   */
  _updateTimeFromMouse(e) {
    if (!this.clockElements.face) return;

    const rect = this.clockElements.face.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    
    const dx = e.clientX - centerX;
    const dy = e.clientY - centerY;
    
    let angle = Math.atan2(dy, dx) * (180 / Math.PI) + 90;
    if (angle < 0) angle += 360;
    
    // Convert angle to 24h time with noon at top.
    const hour24 = (((angle / 360) * 24) + 12) % 24;
    const fadeMins = Number(this.controlState.timeTransitionMinutes) || 0;

    this._dragTimeTarget = hour24;

    const displayHour = Math.floor(hour24);
    const displayMinute = Math.floor((hour24 % 1) * 60);
    const timeText = `${displayHour.toString().padStart(2, '0')}:${displayMinute.toString().padStart(2, '0')}`;

    if (fadeMins > 0) {
      this._updateClockTarget(hour24);
      if (this.clockElements.digital) {
        this.clockElements.digital.textContent = timeText;
      }
      if (this._astrolabe?.setDigitalTime) {
        this._astrolabe.setDigitalTime(timeText);
      }
      if (this._astrolabe?.formatTimeRingHint) {
        this._setContextHint('time-drag', this._astrolabe.formatTimeRingHint(hour24, true));
      }
      return;
    }

    this.controlState.timeOfDay = hour24;
    try {
      const wc = coreWeatherController || window.MapShine?.weatherController;
      wc?.setTime?.(hour24);
    } catch (_) {}
    this._updateClockTarget(hour24);
    if (this.clockElements.digital) {
      this.clockElements.digital.textContent = timeText;
    }
    if (this._astrolabe?.formatTimeRingHint) {
      this._setContextHint('time-drag', this._astrolabe.formatTimeRingHint(hour24, true));
    }
  }

  _onHeaderMouseDown(e) {
    if (!this.container) return;
    if (this.isDraggingClock) return;
    if (e.target?.closest?.('.msa-cp__minimize-btn, button, input, select, .msa-cp-segmented, .msa-cp-segmented__btn')) {
      return;
    }
    if (e.target?.closest?.('.msa-cp-dial-stage, .msa-cp-astrolabe, .msa-cp-weather-finger, .msa-cp__zone--dial')) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    const rect = this.container.getBoundingClientRect();
    this.container.style.transform = 'none';
    this.container.style.left = `${rect.left}px`;
    this.container.style.top = `${rect.top}px`;

    this._isDraggingPanel = true;
    this._dragStart = {
      mx: e.clientX,
      my: e.clientY,
      left: rect.left,
      top: rect.top
    };

    document.addEventListener('mousemove', this._boundHandlers.onDocPanelMouseMove, { capture: true });
    document.addEventListener('mouseup', this._boundHandlers.onDocPanelMouseUp, { capture: true });
  }

  _onHeaderMouseMove(e) {
    if (this.isDraggingClock) return;
    if (!this._isDraggingPanel || !this.container || !this._dragStart) return;
    e.preventDefault();

    const dx = e.clientX - this._dragStart.mx;
    const dy = e.clientY - this._dragStart.my;
    let left = this._dragStart.left + dx;
    let top = this._dragStart.top + dy;

    const pad = 12;
    const maxLeft = Math.max(pad, window.innerWidth - (this.container.offsetWidth + pad));
    const maxTop = Math.max(pad, window.innerHeight - (this.container.offsetHeight + pad));
    left = Math.max(pad, Math.min(maxLeft, left));
    top = Math.max(pad, Math.min(maxTop, top));

    this.container.style.left = `${left}px`;
    this.container.style.top = `${top}px`;
  }

  _onHeaderMouseUp() {
    this._isDraggingPanel = false;
    this._dragStart = null;
    document.removeEventListener('mousemove', this._boundHandlers.onDocPanelMouseMove, { capture: true });
    document.removeEventListener('mouseup', this._boundHandlers.onDocPanelMouseUp, { capture: true });
    this._saveControlPanelUIState();
  }

  /**
   * Set time of day and update UI using centralized StateApplier
   * @param {number} hour - 0-24 hour value
   * @private
   */
  async _setTimeOfDay(hour) {
    this.controlState.timeOfDay = hour % 24;
    this._updateClockTarget(this.controlState.timeOfDay);
    this._updateClock(hour);
    await this._applyControlState();
  }

  /**
   * Queue a save after time-only edits without writing Scene controlState flags.
   * This avoids same-scene redraw/reload paths while still syncing darkness once.
   * @private
   */
  _queueTimeOnlySave() {
    this._skipNextControlStateSceneFlagPersist = true;
    this._syncDarknessOnSkippedPersist = true;
    this.debouncedSave();
  }

  /**
   * Build Weather Director controls inside the unified Weather folder.
   * @param {import('@tweakpane/core').FolderApi} parentFolder
   * @private
   */
  _buildWeatherDirectorContents(mountEl) {
    this._weatherModeSegment = createSegmentedControl(
      { Dynamic: 'dynamic', Directed: 'directed' },
      this.controlState.weatherMode || 'dynamic',
      (v) => {
        this._setWeatherUIMode(v === 'dynamic' ? 'dynamic' : 'directed');
      },
    );
    mountEl.appendChild(this._weatherModeSegment.wrap);

    this._weatherDynamicEl = document.createElement('div');
    this._weatherDynamicEl.className = 'msa-cp-director-dynamic';
    mountEl.appendChild(this._weatherDynamicEl);
    this.dynamicControls = this._buildDynamicControls(this._weatherDynamicEl);

    this._weatherDirectedEl = document.createElement('div');
    this._weatherDirectedEl.className = 'msa-cp-director-directed';
    mountEl.appendChild(this._weatherDirectedEl);
    this.directedControls = this._buildDirectedControls(this._weatherDirectedEl);

    this._updateWeatherControls();
  }

  _buildDynamicControls(mountEl) {
    const note = document.createElement('p');
    note.className = 'msa-cp-director-dynamic__note';
    note.textContent = 'Dynamic environment controls live in the main panel when Dynamic mode is selected.';
    mountEl.appendChild(note);
    return { note: { row: note, mirror: () => {} } };
  }

  _buildDirectedControls(mountEl) {
    const controls = {};
    const preset = createNativeControl({
      type: 'select',
      label: 'Weather',
      target: this.controlState,
      key: 'directedPresetId',
      options: {
        Custom: 'Custom',
        'Clear (Dry)': 'Clear (Dry)',
        'Clear (Breezy)': 'Clear (Breezy)',
        'Partly Cloudy': 'Partly Cloudy',
        'Overcast (Light)': 'Overcast (Light)',
        'Overcast (Heavy)': 'Overcast (Heavy)',
        Mist: 'Mist',
        'Fog (Dense)': 'Fog (Dense)',
        Drizzle: 'Drizzle',
        'Light Rain': 'Light Rain',
        Rain: 'Rain',
        'Heavy Rain': 'Heavy Rain',
        Thunderstorm: 'Thunderstorm',
        'Snow Flurries': 'Snow Flurries',
        Snow: 'Snow',
        Blizzard: 'Blizzard',
      },
      onChange: () => this.debouncedSave(),
    });
    mountEl.appendChild(preset.row);
    controls.preset = preset;

    const transition = createNativeControl({
      type: 'number',
      label: 'Transition (min)',
      target: this.controlState,
      key: 'directedTransitionMinutes',
      min: 0.1,
      max: 60,
      step: 0.1,
      onChange: () => this.debouncedSave(),
    });
    mountEl.appendChild(transition.row);
    controls.transition = transition;

    mountEl.appendChild(createCpButton('Start Transition', () => {
      void this._startDirectedTransition().then(() => this.debouncedSave());
    }));
    return controls;
  }

  _updateWeatherControls() {
    const isDynamic = this.controlState.weatherMode === 'dynamic';
    if (this._weatherDynamicEl) this._weatherDynamicEl.hidden = !isDynamic;
    if (this._weatherDirectedEl) this._weatherDirectedEl.hidden = isDynamic;
    if (this._weatherModeSegment?.wrap) {
      this._weatherModeSegment.wrap.hidden = true;
    }
    if (this._weatherModeSegment?.mirror) {
      this._weatherModeSegment.mirror(isDynamic ? 'dynamic' : 'directed');
    }
    this._dynamicWeatherDeck?.mirror?.();
    this._refreshWeatherFolderTag();
    this._updateManualFogControlAvailability();
  }

  /**
   * Build utilities section
   * @private
   */
  _buildUtilitiesSection(parentFolder = this.pane, options = undefined) {
    const targetFolder = parentFolder || this.pane;
    const utilsFolder = targetFolder.addFolder({
      title: options?.title ?? '⚙️ Utilities (Advanced)',
      expanded: options?.expanded ?? false
    });
    if (options?.registerTopLevel !== false && targetFolder === this.pane) this._registerTopLevelFolder(utilsFolder);
    this._ensureFolderTag(utilsFolder, 'utilities', 'Advanced');

    const contentElement = utilsFolder.element.querySelector('.tp-fldv_c') || utilsFolder.element;
    const grid = document.createElement('div');
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = '1fr 1fr';
    grid.style.gap = '6px';
    grid.style.marginTop = '4px';

    const scopeNote = document.createElement('div');
    scopeNote.textContent = isGmLike()
      ? 'Scope: Saves to scene'
      : 'Scope: Runtime only (GM required for scene persistence)';
    scopeNote.style.fontSize = '11px';
    scopeNote.style.opacity = '0.78';
    scopeNote.style.marginTop = '2px';

    const addGridButton = (title, onClick, danger = false) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = title;
      btn.style.padding = '6px 8px';
      btn.style.borderRadius = '6px';
      btn.style.border = danger
        ? '1px solid rgba(255,120,120,0.45)'
        : '1px solid rgba(255,255,255,0.15)';
      btn.style.background = danger
        ? 'rgba(120,0,0,0.18)'
        : 'rgba(255,255,255,0.06)';
      btn.style.color = 'inherit';
      btn.style.cursor = 'pointer';
      btn.addEventListener('click', onClick);
      grid.appendChild(btn);
    };

    addGridButton('Copy Weather', () => {
      this._copyCurrentWeather();
    });

    addGridButton('Reset Defaults', () => {
      this._resetToDefaults();
    }, true);

    contentElement.appendChild(scopeNote);
    contentElement.appendChild(grid);
  }

  _updateTileMotionStripTag(speedPercent, opts = {}) {
    if (!this._tileMotionStripTag) return;
    const clamped = Math.max(0, Math.min(400, Number(speedPercent) || 0));
    const playing = opts.playing;
    const paused = opts.paused;
    if (playing === false) {
      this._tileMotionStripTag.textContent = 'Stopped';
    } else if (paused === true) {
      this._tileMotionStripTag.textContent = `Paused ${Math.round(clamped)}%`;
    } else {
      this._tileMotionStripTag.textContent = `${Math.round(clamped)}%`;
    }
  }

  _syncTileMotionSpeedFromManager() {
    try {
      const mgr = window.MapShine?.tileMotionManager;
      if (!mgr || typeof mgr.getGlobalState !== 'function') return;

      const global = mgr.getGlobalState();
      const playing = global?.playing === true;
      const paused = global?.paused === true;
      const speed = Number(global?.speedPercent);
      const autoPlay = global?.autoPlayEnabled !== false;
      const timeFactor = Number(global?.timeFactorPercent);

      if (Number.isFinite(speed)) {
        const clamped = Math.max(0, Math.min(400, speed));
        if (Math.abs((this.controlState.tileMotionSpeedPercent ?? 100) - clamped) >= 0.001) {
          this.controlState.tileMotionSpeedPercent = clamped;
        }
        this._updateTileMotionStripTag(clamped, { playing, paused });
      }

      if ((this.controlState.tileMotionAutoPlayEnabled ?? true) !== autoPlay) {
        this.controlState.tileMotionAutoPlayEnabled = autoPlay;
      }

      if (Number.isFinite(timeFactor)) {
        const tf = Math.max(0, Math.min(200, timeFactor));
        if (Math.abs((this.controlState.tileMotionTimeFactorPercent ?? 100) - tf) >= 0.001) {
          this.controlState.tileMotionTimeFactorPercent = tf;
        }
      }

      if ((this.controlState.tileMotionPaused ?? false) !== paused) {
        this.controlState.tileMotionPaused = paused;
      }

      try {
        this._tileMotionSpeedBinding?.mirror?.();
      } catch (_) {}
    } catch (_) {
    }
  }

  async _setTileMotionSpeed(percent, options = undefined) {
    try {
      const mgr = window.MapShine?.tileMotionManager;
      if (!mgr || typeof mgr.setSpeedPercent !== 'function') return false;
      return await mgr.setSpeedPercent(percent, options);
    } catch (error) {
      log.warn('Failed to set tile motion speed:', error);
      return false;
    }
  }

  async _setTileMotionAutoPlayEnabled(enabled, options = undefined) {
    try {
      const mgr = window.MapShine?.tileMotionManager;
      if (!mgr || typeof mgr.setAutoPlayEnabled !== 'function') return false;
      return await mgr.setAutoPlayEnabled(enabled, options);
    } catch (error) {
      log.warn('Failed to set tile motion autoplay:', error);
      return false;
    }
  }

  async _setTileMotionTimeFactor(percent, options = undefined) {
    try {
      const mgr = window.MapShine?.tileMotionManager;
      if (!mgr || typeof mgr.setTimeFactorPercent !== 'function') return false;
      return await mgr.setTimeFactorPercent(percent, options);
    } catch (error) {
      log.warn('Failed to set tile motion time factor:', error);
      return false;
    }
  }

  async _startTileMotion() {
    if (!isGmLike()) {
      ui.notifications?.warn('Tile motion controls are GM-only');
      return;
    }

    const mgr = window.MapShine?.tileMotionManager;
    if (!mgr || typeof mgr.start !== 'function') {
      ui.notifications?.warn('Tile motion manager is not available');
      return;
    }

    const ok = await mgr.start();
    if (!ok) {
      ui.notifications?.warn('Failed to start tile motion');
      return;
    }

    this._syncTileMotionSpeedFromManager();
    ui.notifications?.info('Tile motion started');
  }

  async _pauseTileMotion() {
    if (!isGmLike()) {
      ui.notifications?.warn('Tile motion controls are GM-only');
      return;
    }

    const mgr = window.MapShine?.tileMotionManager;
    if (!mgr || typeof mgr.pause !== 'function') {
      ui.notifications?.warn('Tile motion manager is not available');
      return;
    }

    const ok = await mgr.pause();
    if (!ok) {
      ui.notifications?.warn('Failed to pause tile motion');
      return;
    }

    this._syncTileMotionSpeedFromManager();
    ui.notifications?.info('Tile motion paused');
  }

  async _resumeTileMotion() {
    if (!isGmLike()) {
      ui.notifications?.warn('Tile motion controls are GM-only');
      return;
    }

    const mgr = window.MapShine?.tileMotionManager;
    if (!mgr || typeof mgr.resume !== 'function') {
      ui.notifications?.warn('Tile motion manager is not available');
      return;
    }

    const ok = await mgr.resume();
    if (!ok) {
      ui.notifications?.warn('Failed to resume tile motion');
      return;
    }

    this._syncTileMotionSpeedFromManager();
    ui.notifications?.info('Tile motion resumed');
  }

  async _stopTileMotion() {
    if (!isGmLike()) {
      ui.notifications?.warn('Tile motion controls are GM-only');
      return;
    }

    const mgr = window.MapShine?.tileMotionManager;
    if (!mgr || typeof mgr.stop !== 'function') {
      ui.notifications?.warn('Tile motion manager is not available');
      return;
    }

    const ok = await mgr.stop();
    if (!ok) {
      ui.notifications?.warn('Failed to stop tile motion');
      return;
    }

    ui.notifications?.info('Tile motion stopped');
  }

  async _resetTileMotionPhase() {
    if (!isGmLike()) {
      ui.notifications?.warn('Tile motion controls are GM-only');
      return;
    }

    const mgr = window.MapShine?.tileMotionManager;
    if (!mgr || typeof mgr.resetPhase !== 'function') {
      ui.notifications?.warn('Tile motion manager is not available');
      return;
    }

    const ok = await mgr.resetPhase();
    if (!ok) {
      ui.notifications?.warn('Failed to reset tile motion phase');
      return;
    }

    ui.notifications?.info('Tile motion phase reset');
  }

  _buildOverheadOcclusionSection(mountEl) {
    const canEdit = isGmLike();
    if (!canEdit) {
      const reason = document.createElement('div');
      reason.textContent = 'GM only: radial roof cutout tuning for Map Shine V2 bus.';
      reason.style.cssText = 'font-size:10px;opacity:0.78;margin:4px 8px 8px';
      mountEl.appendChild(reason);
      return;
    }

    const clampR = (x) => {
      const n = Number(x);
      return Number.isFinite(n) ? Math.max(0.05, Math.min(100, n)) : 35.0;
    };
    const clampE = (x) => {
      const n = Number(x);
      return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 1.0;
    };
    this.controlState.replicaOcclusionRadiusScale = clampR(this.controlState.replicaOcclusionRadiusScale);
    this.controlState.replicaOcclusionEdgeSoftness = clampE(this.controlState.replicaOcclusionEdgeSoftness);

    const hint = document.createElement('div');
    hint.textContent = 'Radius × 0.05–100. Soft edge 0–100.';
    hint.style.cssText = 'font-size:9px;opacity:0.65;margin:0 0 6px';
    mountEl.appendChild(hint);

    if (this._replicaOcclDomBuilt) return;

    const board = createFaderBoard(mountEl, [
      { id: 'replicaOcclusionRadiusScale', label: 'Hole radius', min: 0.05, max: 100, step: 0.5 },
      { id: 'replicaOcclusionEdgeSoftness', label: 'Soft edge', min: 0, max: 100, step: 1 },
    ], {
      wireRow: (pid, range) => {
        const clampFn = pid === 'replicaOcclusionRadiusScale' ? clampR : clampE;
        const key = pid;
        range.addEventListener('input', () => {
          if (this._suppressReplicaOcclDom) return;
          const v = range.valueAsNumber;
          if (!Number.isFinite(v)) return;
          this.controlState[key] = clampFn(v);
          mirrorFaderRow(board.rows, pid, this.controlState[key]);
        });
        range.addEventListener('change', () => {
          if (this._suppressReplicaOcclDom) return;
          const v = range.valueAsNumber;
          if (Number.isFinite(v)) this.controlState[key] = clampFn(v);
          this.debouncedSave();
        });
      },
    });

    this._replicaOcclDom = {
      root: board.root,
      rangeR: board.rows.replicaOcclusionRadiusScale?.range,
      rangeE: board.rows.replicaOcclusionEdgeSoftness?.range,
      rows: board.rows,
    };
    this._replicaOcclDomBuilt = true;
    this._syncReplicaOcclDomFromControlState();
  }

  _syncReplicaOcclDomFromControlState() {
    if (!this._replicaOcclDomBuilt || !this._replicaOcclDom || !this.controlState) return;
    const clampR = (x) => {
      const n = Number(x);
      return Number.isFinite(n) ? Math.max(0.05, Math.min(100, n)) : 35.0;
    };
    const clampE = (x) => {
      const n = Number(x);
      return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 1.0;
    };
    const r = clampR(this.controlState.replicaOcclusionRadiusScale);
    const e = clampE(this.controlState.replicaOcclusionEdgeSoftness);
    this.controlState.replicaOcclusionRadiusScale = r;
    this.controlState.replicaOcclusionEdgeSoftness = e;
    this._suppressReplicaOcclDom = true;
    try {
      mirrorFaderRow(this._replicaOcclDom.rows, 'replicaOcclusionRadiusScale', r);
      mirrorFaderRow(this._replicaOcclDom.rows, 'replicaOcclusionEdgeSoftness', e);
    } catch (_) {}
    this._suppressReplicaOcclDom = false;
  }

  /**
   * GM: per-scene Player Light mode allowances + world global defaults.
   * @private
   */
  _buildPlayerLightsSection(mountEl) {
    if (!isGmLike()) {
      const reason = document.createElement('div');
      reason.textContent = 'Player Light allowances are GM-only.';
      reason.style.cssText = 'font-size:10px;opacity:0.78;margin:4px 8px 8px';
      mountEl.appendChild(reason);
      return;
    }

    if (!this.controlState.playerLightAllowance || typeof this.controlState.playerLightAllowance !== 'object') {
      this.controlState.playerLightAllowance = createDefaultPlayerLightAllowance();
    }

    const playerLightModes = [
      { key: 'torch', label: 'Torch' },
      { key: 'flashlight', label: 'Flashlight' },
      { key: 'nightVision', label: 'Night Vision' },
      { key: 'lowLightVision', label: 'Low-light' },
      { key: 'infravision', label: 'Infravision' },
      { key: 'activeIR', label: 'Active IR' },
    ];
    const allowanceOptions = ['global', 'allowed', 'disallowed'];
    const allowanceLabels = { global: 'Global', allowed: 'Allow', disallowed: 'Deny' };

    const MODULE = 'map-shine-advanced';
    const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
    const getPlayerLightParam = (paramId, fallback = 0) => {
      try {
        const eff = window.MapShine?.uiManager?.effectFolders?.['player-light'];
        const n = Number(eff?.params?.[paramId]);
        return Number.isFinite(n) ? clamp01(n) : fallback;
      } catch (_) {
        return fallback;
      }
    };
    const setPlayerLightParam = (paramId, value) => {
      try {
        const uiManager = window.MapShine?.uiManager;
        const eff = uiManager?.effectFolders?.['player-light'];
        if (!eff?.params || !Object.prototype.hasOwnProperty.call(eff.params, paramId)) return;
        const next = clamp01(value);
        eff.params[paramId] = next;
        try { eff.bindings?.[paramId]?.refresh?.(); } catch (_) {}
        try { uiManager?.effectCallbacks?.get?.('player-light')?.('player-light', paramId, next); } catch (_) {}
        try {
          uiManager?.updateEffectiveState?.('player-light');
          uiManager?.updateControlStates?.('player-light');
          uiManager?.queueSave?.('player-light');
        } catch (_) {}
      } catch (_) {}
    };

    const summaryEl = document.createElement('div');
    summaryEl.className = 'msa-cp-pl-summary';
    mountEl.appendChild(summaryEl);

    const updateSummary = () => {
      try {
        const scene = canvas?.scene ?? null;
        const lines = ['Effective for players:'];
        for (const { key, label } of playerLightModes) {
          const ok = resolvePlayerLightModeAllowance(key, { scene, controlState: this.controlState });
          lines.push(`• ${label}: ${ok ? 'Allowed' : 'Disallowed'}`);
        }
        summaryEl.textContent = lines.join('\n');
      } catch (_) {
        summaryEl.textContent = '';
      }
    };
    updateSummary();

    const matrix = document.createElement('div');
    matrix.className = 'msa-cp-pl-matrix';
    matrix.appendChild(Object.assign(document.createElement('div'), { className: 'msa-cp-pl-matrix__head', textContent: '' }));
    for (const opt of allowanceOptions) {
      const h = document.createElement('div');
      h.className = 'msa-cp-pl-matrix__head';
      h.textContent = allowanceLabels[opt];
      matrix.appendChild(h);
    }

    const mirrorMatrix = () => {
      for (const btn of matrix.querySelectorAll('.msa-cp-pl-cell')) {
        const { modeKey, value } = btn.dataset;
        btn.classList.toggle('is-active', this.controlState.playerLightAllowance[modeKey] === value);
      }
    };

    for (const { key, label } of playerLightModes) {
      const modeLbl = document.createElement('div');
      modeLbl.className = 'msa-cp-pl-matrix__mode';
      modeLbl.textContent = label;
      matrix.appendChild(modeLbl);
      for (const opt of allowanceOptions) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'msa-cp-pl-cell';
        cell.dataset.modeKey = key;
        cell.dataset.value = opt;
        cell.textContent = allowanceLabels[opt];
        cell.classList.toggle('is-active', this.controlState.playerLightAllowance[key] === opt);
        cell.addEventListener('click', () => {
          this.controlState.playerLightAllowance[key] = opt;
          mirrorMatrix();
          updateSummary();
          this.debouncedSave();
          try { ui?.controls?.render?.(true); } catch (_) {}
        });
        matrix.appendChild(cell);
      }
    }
    mountEl.appendChild(matrix);

    const flashSec = createSection(mountEl, { id: 'flashlightBehavior', title: 'Flashlight Behavior', collapsible: true, expanded: false });
    const flashlightState = {
      flashlightWobble: getPlayerLightParam('flashlightWobble', 0),
      flashlightBrokenness: getPlayerLightParam('flashlightBrokenness', 0),
    };
    const wobble = createNativeControl({
      type: 'range', label: 'Wobble', target: flashlightState, key: 'flashlightWobble', min: 0, max: 1, step: 0.01,
      onChange: (v) => setPlayerLightParam('flashlightWobble', v),
    });
    const broken = createNativeControl({
      type: 'range', label: 'Broken', target: flashlightState, key: 'flashlightBrokenness', min: 0, max: 1, step: 0.01,
      onChange: (v) => setPlayerLightParam('flashlightBrokenness', v),
    });
    flashSec.body.appendChild(wobble.row);
    flashSec.body.appendChild(broken.row);

    const globalSec = createSection(mountEl, { id: 'plGlobal', title: 'Global Defaults', collapsible: true, expanded: false });
    const globalDefaultsState = {
      torch: !!game.settings.get(MODULE, 'playerLightTorchAllowedDefault'),
      flashlight: !!game.settings.get(MODULE, 'playerLightFlashlightAllowedDefault'),
      nightVision: getGlobalPlayerLightModeAllowed('nightVision'),
      lowLightVision: getGlobalPlayerLightModeAllowed('lowLightVision'),
      infravision: getGlobalPlayerLightModeAllowed('infravision'),
      activeIR: getGlobalPlayerLightModeAllowed('activeIR'),
    };
    const addGlobalToggle = (label, key, settingKey, extra) => {
      const ctrl = createNativeControl({
        type: 'toggle', label, target: globalDefaultsState, key,
        onChange: async (v) => {
          globalDefaultsState[key] = !!v;
          try {
            await game.settings.set(MODULE, settingKey, !!v);
            if (extra) await extra(!!v);
          } catch (_) {}
          updateSummary();
          try { ui?.controls?.render?.(true); } catch (_) {}
        },
      });
      globalSec.body.appendChild(ctrl.row);
    };
    addGlobalToggle('Torch', 'torch', 'playerLightTorchAllowedDefault');
    addGlobalToggle('Flashlight', 'flashlight', 'playerLightFlashlightAllowedDefault');
    addGlobalToggle('Night Vision', 'nightVision', 'playerLightNightVisionAllowedDefault', async (v) => {
      await game.settings.set(MODULE, 'nightVisionAllowPlayers', v);
    });
    addGlobalToggle('Low-light Vision', 'lowLightVision', 'playerLightLowLightVisionAllowedDefault');
    addGlobalToggle('Infravision', 'infravision', 'playerLightInfravisionAllowedDefault');
    addGlobalToggle('Active IR', 'activeIR', 'playerLightActiveIRAllowedDefault');
  }

  /**
   * Apply control state to game systems using centralized StateApplier
   * @private
   */
  async _applyControlState() {
    try {
      // Debounced scene-flag saves lag behind Tweakpane sliders; arm same-scene tearDown skip for Mode/Dynamic/Directed/time paths.
      refreshMsaSameSceneRedrawPredict();

      const targetHour = ((Number(this.controlState.timeOfDay) % 24) + 24) % 24;
      const transitionMinutes = Number(this.controlState.timeTransitionMinutes) || 0;
      const shouldStartTransition =
        transitionMinutes > 0 &&
        (this._lastTimeTargetApplied === null ||
          Math.abs(this._lastTimeTargetApplied - targetHour) > 1e-4);

      const shouldApplyInstant =
        transitionMinutes <= 0 &&
        (this._lastTimeTargetApplied === null || Math.abs(this._lastTimeTargetApplied - targetHour) > 1e-4);

      if (this._environmentFadeTransitionActive) {
        // Active environment fade owns time/scene application.
      } else if (shouldStartTransition) {
        this._lastTimeTargetApplied = targetHour;
        this._lastTimeTransitionMinutesApplied = transitionMinutes;
        await this._startEnvironmentTransition(
          snapshotFromControlState(this.controlState, MAX_WIND_MS_CP),
          transitionMinutes,
          environmentControlApi.captureSnapshot(),
        );
      } else if (shouldApplyInstant) {
        this._lastTimeTargetApplied = targetHour;
        this._lastTimeTransitionMinutesApplied = transitionMinutes;
        // Do not call Foundry scene darkness from live slider — sync once on debouncedSave.
        await stateApplier.applyTimeOfDay(targetHour, false, false);
      }

      if (this._suppressInitialWeatherApply) {
        this._suppressInitialWeatherApply = false;
        this._syncLandscapeLightningAndFogFromControlState();
        return;
      }

      // Apply weather state using centralized logic
      const weatherState = {
        mode: this.controlState.weatherMode,
        dynamicEnabled: this.controlState.dynamicEnabled,
        dynamicPresetId: this.controlState.dynamicPresetId,
        dynamicEvolutionSpeed: this.controlState.dynamicEvolutionSpeed,
        dynamicPaused: this.controlState.dynamicPaused
      };
      await stateApplier.applyWeatherState(weatherState, false); // Don't save here, handled by debouncedSave

      // Important: applyWeatherState handles mode/dynamic only — directed Custom scalars
      // need _applyRapidWeatherOverrides. Do NOT run that on every _applyControlState:
      // time-of-day changes call this path constantly and would overwrite WC + persisted
      // weather-snapshot with directedCustomPreset (e.g. wind 0) even when the user only
      // moved the clock. Only re-apply when weather-relevant control state actually changed.
      const shouldApplyRapidCustom =
        this.controlState.weatherMode === 'directed' &&
        this.controlState.directedPresetId === 'Custom';
      if (shouldApplyRapidCustom && !this._applyingRapidOverrides) {
        const fp = this._weatherControlFingerprint();
        if (this._lastWeatherControlFingerprint !== fp) {
          await this._applyRapidWeatherOverrides();
        }
      }

      this._syncLandscapeLightningAndFogFromControlState();

      log.debug('Applied control state via StateApplier:', this.controlState);
    } catch (error) {
      log.error('Failed to apply control state:', error);
    }
  }

  /**
   * Apply wind state to weather controller
   * @private
   */
  async _applyWindState() {
    try {
      refreshMsaSameSceneRedrawPredict();

      const weatherController = coreWeatherController || window.MapShine?.weatherController || window.weatherController;
      if (!weatherController) {
        log.warn('WeatherController not available for wind application');
        return;
      }

      this._coercePanelWindScalarsInPlace();

      const gustKey = this.controlState.gustiness;
      const variability = GUSTINESS_TO_VARIABILITY[gustKey] ?? GUSTINESS_TO_VARIABILITY.moderate;
      if (typeof weatherController.setVariability === 'function') {
        weatherController.setVariability(variability);
      } else {
        weatherController.variability = Math.max(0, Math.min(1, variability));
      }

      const degRaw = Number(this.controlState.windDirection);
      const degSafe = Number.isFinite(degRaw) ? ((degRaw % 360) + 360) % 360 : 0.0;
      const resolvedWindDir = (typeof weatherController._windDirFromAngleDeg === 'function')
        ? weatherController._windDirFromAngleDeg(degSafe)
        : (() => {
            const rad = (degSafe * Math.PI) / 180.0;
            return { x: Math.cos(rad), y: -Math.sin(rad) };
          })();
      const dirX = Number.isFinite(resolvedWindDir?.x) ? resolvedWindDir.x : 1.0;
      const dirY = Number.isFinite(resolvedWindDir?.y) ? resolvedWindDir.y : 0.0;

      // WeatherController.update() derives currentState from targetState every frame.
      // So, to make the override "stick", we must write to targetState.
      // Also: windDirection is expected to be a THREE.Vector2 after initialize(); never replace it.
      const applyToState = (state) => {
        if (!state) return;
        const windMS = Number(this.controlState.windSpeedMS);
        const clampedMS = Number.isFinite(windMS) ? Math.max(0.0, Math.min(MAX_WIND_MS_CP, windMS)) : 0.0;
        state.windSpeedMS = clampedMS;
        state.windSpeed = clampedMS / MAX_WIND_MS_CP;

        const wd = state.windDirection;
        if (wd && typeof wd.set === 'function') {
          wd.set(dirX, dirY);
          if (typeof wd.normalize === 'function') wd.normalize();
        } else {
          state.windDirection = { x: dirX, y: dirY };
        }
      };

      applyToState(weatherController.targetState);
      applyToState(weatherController.currentState);

      this._ensureDirectedCustomPreset();
      const preset = this.controlState.directedCustomPreset;
      if (preset && typeof preset === 'object') {
        const ms = Number(this.controlState.windSpeedMS);
        const clampedMS = Number.isFinite(ms) ? Math.max(0.0, Math.min(MAX_WIND_MS_CP, ms)) : 0.0;
        preset.windSpeed = clampedMS / MAX_WIND_MS_CP;
        preset.windDirection = this.controlState.windDirection;
        this._sanitizeDirectedCustomPresetNumbers(preset);
      }
      this.syncLiveWeatherOverrideDomFromDirectedPreset();
      this._lastWeatherControlFingerprint = this._weatherControlFingerprint();
      this._updateWindUI(weatherController);

      log.debug('Applied wind state:', {
        speedMS: this.controlState.windSpeedMS,
        direction: this.controlState.windDirection,
        gustiness: this.controlState.gustiness,
        variability
      });
    } catch (error) {
      log.error('Failed to apply wind state:', error);
    }
  }

  /**
   * Start directed weather transition using centralized StateApplier
   * @private
   */
  async _startDirectedTransition() {
    try {
      // Ensure the persisted control state reflects that we're now in Directed mode.
      // Without this, the saved controlState can keep weatherMode='dynamic' and re-enable
      // Dynamic Weather via flag sync after refresh, which blocks subsequent directed transitions.
      this.controlState.weatherMode = 'directed';
      this.controlState.dynamicEnabled = false;

      // Persist immediately (not debounced) so other clients and post-refresh sync can't
      // override the directed transition we are about to start.
      await this._saveControlState();

      await stateApplier.startDirectedTransition(
        this.controlState.directedPresetId,
        this.controlState.directedTransitionMinutes
      );

      try {
        const wc = resolveWeatherController();
        if (wc?.saveWeatherSnapshotNow) {
          await wc.saveWeatherSnapshotNow();
        }
      } catch (_) {}
      
      ui.notifications?.info(`Weather transition started: ${this.controlState.directedPresetId}`);
      log.info('Started directed weather transition:', this.controlState.directedPresetId);

    } catch (error) {
      log.error('Failed to start directed transition:', error);
      ui.notifications?.error('Failed to start weather transition');
    }
  }

  /**
   * Reset control state to defaults
   * @private
   */
  _resetToDefaults() {
    this.controlState = {
      timeOfDay: 12.0,
      timeTransitionMinutes: 0.0,
      linkTimeToFoundry: false,
      weatherMode: 'dynamic',
      dynamicEnabled: false,
      dynamicPresetId: 'Temperate Plains',
      dynamicEvolutionSpeed: 60.0,
      dynamicPaused: false,
      directedPresetId: 'Clear (Dry)',
      directedTransitionMinutes: 5.0,
      directedCustomPreset: {
        precipitation: 0.0,
        cloudCover: 0.15,
        windSpeed: 39.0 / 78.0,
        windDirection: 180.0,
        fogDensity: 0.0,
        freezeLevel: 0.0
      },
      windSpeedMS: 39.0,
      windDirection: 180.0,
      gustiness: 'moderate',
      tileMotionSpeedPercent: 100,
      tileMotionAutoPlayEnabled: true,
      tileMotionTimeFactorPercent: 100,
      tileMotionPaused: false,
      replicaOcclusionRadiusScale: 35.0,
      replicaOcclusionEdgeSoftness: 1.0,
      manualFogDensity: 0.0,
      landscapeLightning: {
        lightning: 1.0,
      },
    };
    this._ensureDirectedCustomPreset();
    this._lastWeatherControlFingerprint = null;

    this._updateClock(12.0);
    void this._applyControlState().then(async () => {
      await this._setTileMotionSpeed(this.controlState.tileMotionSpeedPercent);
      await this._setTileMotionAutoPlayEnabled(this.controlState.tileMotionAutoPlayEnabled);
      await this._setTileMotionTimeFactor(this.controlState.tileMotionTimeFactorPercent);
      await this._setTileMotionPaused(this.controlState.tileMotionPaused);
      await this._saveControlState();
    });
    
    this._mirrorAllDomFromState();
    this._sanitizeControlStateForTweakpaneBindings();
    this._updateCustomTimeControls();

    ui.notifications?.info('Control panel reset to defaults');
  }

  /**
   * Copy current weather state to clipboard
   * @private
   */
  _copyCurrentWeather() {
    try {
      const weatherController = coreWeatherController || window.MapShine?.weatherController || window.weatherController;
      if (!weatherController) {
        ui.notifications?.warn('Weather controller not available');
        return;
      }

      const state = weatherController.getCurrentState?.();
      if (!state) {
        ui.notifications?.warn('Weather state not available');
        return;
      }

      const windMS = (() => {
        const ms = Number(state.windSpeedMS);
        if (Number.isFinite(ms)) return Math.max(0.0, Math.min(78.0, ms));
        const legacy01 = Number(state.windSpeed);
        if (Number.isFinite(legacy01)) return Math.max(0.0, Math.min(78.0, legacy01 * 78.0));
        return 0.0;
      })();

      const weatherText = `
Current Weather:
- Precipitation: ${(state.precipitation * 100).toFixed(0)}%
- Cloud Cover: ${(state.cloudCover * 100).toFixed(0)}%
- Wind Speed: ${windMS.toFixed(1)} m/s
- Fog Density: ${(state.fogDensity * 100).toFixed(0)}%
- Temperature: ${state.freezeLevel < 0.5 ? 'Warm' : 'Cold'}
- Time: ${Math.floor(this.controlState.timeOfDay).toString().padStart(2, '0')}:${Math.floor((this.controlState.timeOfDay % 1) * 60).toString().padStart(2, '0')}
      `.trim();

      navigator.clipboard.writeText(weatherText).then(() => {
        ui.notifications?.info('Weather state copied to clipboard');
      }).catch(() => {
        ui.notifications?.error('Failed to copy to clipboard');
      });

    } catch (error) {
      log.error('Failed to copy weather state:', error);
      ui.notifications?.error('Failed to copy weather state');
    }
  }

  /**
   * Coerce scene-persisted control fields so Tweakpane option bindings do not throw.
   * @private
   */
  _sanitizeControlStateForTweakpaneBindings() {
    sanitizeControlStateInPlace(this.controlState, { silent: false });
    this._ensureDirectedCustomPreset();
    this._syncReplicaOcclDomFromControlState();
  }

  /**
   * Reload control + weather state from scene flags after an external settings apply (preset).
   * @returns {Promise<void>}
   * @public
   */
  async resyncFromSceneFlags() {
    try {
      await this._loadControlState();

      const snap = canvas?.scene?.getFlag?.('map-shine-advanced', 'weather-snapshot');
      if (snap && typeof snap === 'object') {
        if (snap.controlState && typeof snap.controlState === 'object' && !Array.isArray(snap.controlState)) {
          Object.assign(this.controlState, cloneAndSanitizeControlState(snap.controlState, { silent: true }));
          this._ensureDirectedCustomPreset();
        }
        if (Number.isFinite(snap.timeOfDay)) {
          this.controlState.timeOfDay = snap.timeOfDay % 24;
        }
        if (typeof snap.linkTimeToFoundry === 'boolean') {
          this.controlState.linkTimeToFoundry = snap.linkTimeToFoundry;
        }
        const tt = Number(snap.timeTransitionMinutes);
        if (Number.isFinite(tt)) {
          this.controlState.timeTransitionMinutes = tt;
        }
      }

      this._sanitizeControlStateForTweakpaneBindings();
      inferWeatherPanelView(this.controlState);
      this._updateCustomTimeControls();
      this._syncTileMotionSpeedFromManager();
      this._lastWeatherControlFingerprint = null;
      this._lastTimeTargetApplied = null;
      this._lastTimeTransitionMinutesApplied = null;

      this._mirrorAllDomFromState();
      this._applyWeatherPanelViewVisibility();

      await this._applyControlState();
    } catch (error) {
      log.warn('resyncFromSceneFlags failed:', error);
    }
  }

  /**
   * Load control state from scene flags
   * @private
   */
  async _loadControlState() {
    try {
      const scene = canvas?.scene;
      if (!scene) return false;

      const saved = scene.getFlag('map-shine-advanced', 'controlState');
      if (saved) {
        // Merge with defaults to handle missing properties
        Object.assign(this.controlState, saved);
        this._ensureDirectedCustomPreset();

        // Backwards compatibility: older scenes saved legacy windSpeed (0..1).
        // If windSpeedMS is missing, derive it from windSpeed.
        if (!Number.isFinite(this.controlState.windSpeedMS)) {
          const legacy01 = Number(saved?.windSpeed);
          if (Number.isFinite(legacy01)) {
            this.controlState.windSpeedMS = Math.max(0.0, Math.min(78.0, legacy01 * 78.0));
          }
        }
        // Cleanup: don't keep the legacy field around in the live control state.
        if ('windSpeed' in this.controlState) {
          try { delete this.controlState.windSpeed; } catch (_) {}
        }
        inferWeatherPanelView(this.controlState);
        log.info('Loaded control state from scene flags');
        // Force one rapid-custom apply on next _applyControlState for this scene.
        this._lastWeatherControlFingerprint = null;
        return true;
      }
    } catch (error) {
      log.warn('Failed to load control state:', error);
    }

    return false;
  }

  /**
   * Save control state to scene flags
   * @private
   */
  async _saveControlState() {
    try {
      const scene = canvas?.scene;
      if (!scene || !canPersistSceneDocument()) return;

      if (this._skipNextControlStateSceneFlagPersist === true) {
        this._skipNextControlStateSceneFlagPersist = false;
        const syncDarkness = this._syncDarknessOnSkippedPersist === true;
        this._syncDarknessOnSkippedPersist = false;
        if (syncDarkness) {
          await stateApplier.syncFoundryDarknessFromMapShineTime();
        }
        // Time fields are not written to `controlState` flags (see below). Persist the
        // authoritative hour + full WC state via weather-snapshot instead (separate flag key).
        try {
          const wc = resolveWeatherController();
          if (wc?.saveWeatherSnapshotNow) {
            await wc.saveWeatherSnapshotNow();
          }
          if (wc?.saveDynamicStateNow) {
            await wc.saveDynamicStateNow();
          }
        } catch (_) {}
        log.debug('Skipped Scene controlState flag persist for live/time-only save (weather-snapshot updated)');
        return;
      }

      // V14 regression guard:
      // Persisting `timeOfDay` to Scene flags causes document updates that can
      // trigger same-scene redraw/transition paths. Keep time runtime-local and
      // persist only non-time control fields.
      const persistedControlState = { ...this.controlState };
      try { delete persistedControlState.timeOfDay; } catch (_) {}
      try { delete persistedControlState.timeTransitionMinutes; } catch (_) {}
      try { delete persistedControlState.linkTimeToFoundry; } catch (_) {}

      extendMsaLocalFlagWriteGuard();
      await scene.setFlag('map-shine-advanced', 'controlState', persistedControlState);
      // Reconcile local runtime darkness after persist. Time transitions already
      // apply this during the ramp without writing the Scene document.
      await stateApplier.syncFoundryDarknessFromMapShineTime();
      try {
        const wc = resolveWeatherController();
        if (wc?.saveWeatherSnapshotNow) {
          await wc.saveWeatherSnapshotNow();
        }
        if (wc?.saveDynamicStateNow) {
          await wc.saveDynamicStateNow();
        }
      } catch (_) {}
      log.debug('Saved control state to scene flags');
      this._emitWeatherSyncAfterSave();
    } catch (error) {
      log.warn('Failed to save control state:', error);
    }
  }

  /**
   * Emit throttled live weather sync packets after a full controlState persist.
   * @private
   */
  _emitWeatherSyncAfterSave() {
    try {
      const bridge = getWeatherSyncBridge();
      bridge.emitMode(this.controlState, { immediate: false });
      const wc = resolveWeatherController();
      if (!wc) return;
      bridge.emitSnapshot({
        version: 1,
        enabled: wc.enabled === true,
        dynamicEnabled: wc.dynamicEnabled === true,
        dynamicPresetId: wc.dynamicPresetId,
        dynamicEvolutionSpeed: wc.dynamicEvolutionSpeed,
        dynamicPaused: wc.dynamicPaused === true,
        timeOfDay: Number.isFinite(Number(wc.timeOfDay)) ? wc.timeOfDay : this.controlState.timeOfDay,
        timeTransitionMinutes: this.controlState.timeTransitionMinutes,
        linkTimeToFoundry: this.controlState.linkTimeToFoundry,
        start: wc._serializeWeatherState?.(wc.startState),
        current: wc._serializeWeatherState?.(wc.currentState),
        target: wc._serializeWeatherState?.(wc.targetState),
        isTransitioning: wc.isTransitioning === true,
        transitionDuration: Number(wc.transitionDuration) || 0,
        transitionElapsed: Number(wc.transitionElapsed) || 0,
        controlState: cloneAndSanitizeControlState(this.controlState, { silent: true }),
      }, { force: false });
    } catch (_) {}
  }

  /**
   * Simple debounce utility
   * @param {Function} func
   * @param {number} wait
   * @returns {Function}
   * @private
   */
  _debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  /**
   * Show the control panel
   */
  show() {
    if (!this.container) return;

    if (this._isMinimized) {
      const left = this._readPx(this._minimizedDock?.style?.left);
      const top = this._readPx(this._minimizedDock?.style?.top);
      if (Number.isFinite(left) && Number.isFinite(top)) {
        this.container.style.transform = 'none';
        this.container.style.left = `${left}px`;
        this.container.style.top = `${top}px`;
      }
      this._hideMinimizedDock();
      this._isMinimized = false;
    }
    
    this._setPanelDomVisible(true);
    this.visible = true;
    
    // Update clock to current state
    this._updateClock(this.controlState.timeOfDay);
    this._syncTimeScaleBindingFromUiManager();

    this._wireLiveWeatherOverrideBindingsIfReady();
    try {
      hydrateControlPanelLiveOverridesFromController(resolveWeatherController());
    } catch (_) {}
    this._mirrorAllDomFromState();
    this._syncLandscapeLightningAndFogFromControlState();

    // Ensure status panel is up to date immediately.
    this._updateStatusPanel();

    // Start status updates
    if (this._statusIntervalId) clearInterval(this._statusIntervalId);
    // T3-D: 500ms is sufficient for status display (FPS, frame time) — halves timer overhead.
    this._statusIntervalId = setInterval(() => {
      try {
        this._updateStatusPanel();
      } catch (e) {
      }
    }, 500);

    this._saveControlPanelUIState();
    
    log.debug('Control panel shown');
  }

  /**
   * Hide the control panel
   */
  hide() {
    if (!this.container) return;
    
    this._setPanelDomVisible(false);
    this.visible = false;
    this._isMinimized = false;
    this._hideMinimizedDock();

    if (this._statusIntervalId) {
      clearInterval(this._statusIntervalId);
      this._statusIntervalId = null;
    }

    this._saveControlPanelUIState();
    
    log.debug('Control panel hidden');
  }

  /**
   * Toggle panel visibility
   */
  toggle() {
    if (this.visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  /**
   * Clean up resources
   */
  destroy() {
    // Clear timers
    if (this._darknessTimer) {
      clearTimeout(this._darknessTimer);
    }

    if (this._statusIntervalId) {
      clearInterval(this._statusIntervalId);
      this._statusIntervalId = null;
    }

    if (this._sunLatitudeSyncIntervalId !== null) {
      clearInterval(this._sunLatitudeSyncIntervalId);
      this._sunLatitudeSyncIntervalId = null;
    }

    this._unregisterFoundryTimeHook();

    // Remove event listeners
    if (this.clockElements.face) {
      this.clockElements.face.removeEventListener('mousedown', this._boundHandlers.onFaceMouseDown);
      this.clockElements.face.removeEventListener('touchstart', this._boundHandlers.onFaceTouchStart);
    }
    if (this.clockElements?.handHub) {
      this.clockElements.handHub.removeEventListener('mousedown', this._boundHandlers.onFaceMouseDown);
      this.clockElements.handHub.removeEventListener('touchstart', this._boundHandlers.onFaceTouchStart);
    }
    document.removeEventListener('mousemove', this._boundHandlers.onDocMouseMove, { capture: true });
    document.removeEventListener('mouseup', this._boundHandlers.onDocMouseUp, { capture: true });
    document.removeEventListener('touchmove', this._boundHandlers.onDocTouchMove);
    document.removeEventListener('touchend', this._boundHandlers.onDocTouchEnd);

    document.removeEventListener('mousemove', this._boundHandlers.onDocPanelMouseMove, { capture: true });
    document.removeEventListener('mouseup', this._boundHandlers.onDocPanelMouseUp, { capture: true });
    document.removeEventListener('pointermove', this._boundHandlers.onMinimizedDockPointerMove, { capture: true });
    document.removeEventListener('pointerup', this._boundHandlers.onMinimizedDockPointerUp, { capture: true });
    document.removeEventListener('pointercancel', this._boundHandlers.onMinimizedDockPointerUp, { capture: true });

    if (this.headerOverlay) {
      this.headerOverlay.removeEventListener('mousedown', this._boundHandlers.onHeaderMouseDown);
    }

    if (this._minimizeButton) {
      this._minimizeButton.removeEventListener('click', this._boundHandlers.onMinimizeButtonClick);
    }

    if (this._minimizedOpenBtn) {
      this._minimizedOpenBtn.removeEventListener('click', this._boundHandlers.onMinimizedOpenClick);
    }

    if (this._minimizedHandle) {
      this._minimizedHandle.removeEventListener('pointerdown', this._boundHandlers.onMinimizedHandlePointerDown);
    }

    if (this._minimizedDock?.parentNode) {
      this._minimizedDock.parentNode.removeChild(this._minimizedDock);
    }

    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }

    // Clear references
    this.clockElement = null;
    this.clockElements = {};
    this.statusPanel = null;
    this._statusEls = null;
    this.headerOverlay = null;
    this._minimizeButton = null;
    this._minimizedDock = null;
    this._minimizedOpenBtn = null;
    this._minimizedHandle = null;
    this._isMinimized = false;
    this._isDraggingMinimizedDock = false;
    this._minimizedDragStart = null;
    this._sunLatitudeBinding = null;
    this._tileMotionSpeedBinding = null;

    this._liveWeatherOverrideDomBuilt = false;
    this._rapidWeatherBindingTarget = null;
    this._liveWeatherOverrideFolder = null;
    this._liveWeatherOverrideDom = null;
    this._weatherUnifiedFolder = null;
    this._weatherManualViewEl = null;
    this._weatherDirectorViewEl = null;
    this._weatherViewToggleButtons = null;
    this._windGustinessBinding = null;

    log.info('Control panel destroyed');
  }
}
