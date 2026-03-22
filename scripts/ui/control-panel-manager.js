/**
 * @fileoverview Control Panel Manager - GM live-play interface
 * Compact Tweakpane-based UI for time-of-day and weather control during actual play
 * @module ui/control-panel-manager
 */

import { createLogger } from '../core/log.js';
import { stateApplier } from './state-applier.js';
import { weatherController as coreWeatherController } from '../core/WeatherController.js';
import {
  applyDirectedCustomPresetToWeather,
  applyWeatherManualParam,
  resolveWeatherController,
  hydrateControlPanelLiveOverridesFromController,
  LIVE_WEATHER_OVERRIDE_PARAM_IDS
} from './weather-param-bridge.js';
import { debugLoadingProfiler } from '../core/debug-loading-profiler.js';
import { getFoundryTimePhaseHours } from '../core/foundry-time-phases.js';
import { extendMsaLocalFlagWriteGuard } from '../utils/msa-local-flag-guard.js';

const log = createLogger('ControlPanel');

/**
 * Manages the GM Control Panel with time-of-day clock and weather controls
 * Optimized for live play - fast, concise, authoritative
 */
export class ControlPanelManager {
  constructor() {
    /** @type {Tweakpane.Pane|null} */
    this.pane = null;
    
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
      // Dynamic mode
      dynamicEnabled: false,
      dynamicPresetId: 'Temperate Plains',
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
      tileMotionPaused: false
    };

    this._suppressInitialWeatherApply = false;

    /**
     * Stable object reference for `directedCustomPreset` merge (flags / scene sync).
     * Live overrides UI is plain DOM; this still keeps one canonical preset object.
     * @type {Object|null}
     */
    this._rapidWeatherBindingTarget = this.controlState.directedCustomPreset;

    /** True once Live Weather Overrides DOM rows are built (idempotent). */
    this._liveWeatherOverrideDomBuilt = false;

    /** @type {any|null} Tweakpane folder API for live weather overrides */
    this._liveWeatherOverrideFolder = null;

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
    
    /** @type {Function} Debounced save function */
    this.debouncedSave = this._debounce(() => this._saveControlState(), 500);

    /** @type {HTMLElement|null} */
    this.statusPanel = null;

    /** @type {HTMLElement|null} */
    this.headerOverlay = null;

    /** @type {HTMLInputElement|null} Custom time transition input (replaces Tweakpane binding) */
    this._timeTransitionInput = null;

    /** @type {HTMLInputElement|null} Custom link-to-Foundry checkbox */
    this._timeLinkCheckbox = null;

    /** @type {HTMLButtonElement|null} */
    this._minimizeButton = null;

    /** @type {HTMLButtonElement|null} */
    this._minimizedButton = null;

    /** @type {boolean} */
    this._isMinimized = false;

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

    /** @type {any|null} */
    this._tileMotionAutoPlayBinding = null;

    /** @type {any|null} */
    this._tileMotionTimeFactorBinding = null;

    /** @type {any|null} */
    this._tileMotionPausedBinding = null;

    /** @type {any|null} */
    this._weatherDynamicFolder = null;

    /** @type {any|null} */
    this._weatherDirectedFolder = null;

    /** @type {boolean} */
    this._singleOpenTopLevelSections = false;

    /** @type {Array<any>} */
    this._topLevelFolders = [];

    /** @type {Object<string, HTMLElement|null>} */
    this._folderTags = {
      master: null,
      quick: null,
      time: null,
      weather: null,
      wind: null,
      tileMotion: null,
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
      onMinimizedBadgeClick: (e) => this._onMinimizedBadgeClick(e)
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

  _registerTopLevelFolder(folder) {
    if (!folder) return;
    this._topLevelFolders.push(folder);
  }

  _ensureFolderTag(folder, key, initialText = '') {
    try {
      const titleElement = folder?.element?.querySelector?.('.tp-fldv_t');
      if (!titleElement) return null;

      let tag = titleElement.querySelector(`.map-shine-folder-tag-${key}`);
      if (!tag) {
        tag = document.createElement('span');
        tag.className = `map-shine-folder-tag map-shine-folder-tag-${key}`;
        tag.style.marginLeft = '8px';
        tag.style.fontSize = '10px';
        tag.style.fontWeight = '600';
        tag.style.padding = '1px 6px';
        tag.style.borderRadius = '999px';
        tag.style.border = '1px solid rgba(255,255,255,0.14)';
        tag.style.background = 'rgba(255,255,255,0.08)';
        tag.style.opacity = '0.9';
        tag.style.verticalAlign = 'middle';
        tag.style.pointerEvents = 'none';
        titleElement.appendChild(tag);
      }

      this._folderTags[key] = tag;
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
    const tag = this._folderTags?.[key];
    if (!tag) return;
    const next = String(text || '').trim();
    tag.textContent = next;
    tag.style.display = next ? 'inline-block' : 'none';
  }

  _refreshWeatherFolderTag() {
    const isDynamic = this.controlState.weatherMode === 'dynamic';
    this._setFolderTag('weather', isDynamic ? 'Dynamic' : 'Directed');
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
    const masterFolder = this.pane.addFolder({
      title: '🎛️ Master Control',
      expanded: true
    });
    this._registerTopLevelFolder(masterFolder);
    this._ensureFolderTag(masterFolder, 'master', 'Live');

    this._ensureDirectedCustomPreset();
    this._buildRapidWeatherOverrides(masterFolder);
    this._buildTimeSection(masterFolder, { expanded: true, registerTopLevel: false });
    this._buildQuickSceneBeatsSection(masterFolder, { expanded: true, registerTopLevel: false });
    this._buildTileMotionSection(masterFolder, { expanded: false, registerTopLevel: false });
    this._buildWeatherSection(masterFolder, { expanded: false, registerTopLevel: false });
    this._buildWindSection(masterFolder, { expanded: false, registerTopLevel: false });
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

  _injectPanelStyles() {
    const STYLE_ID = 'map-shine-cp-phase-d-style';
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      /* ═══ Map Shine Control Panel — Phase D Visual Polish ═══ */

      /* Container frame */
      #map-shine-control-panel {
        width: 292px !important;
        max-width: 292px !important;
        border-radius: 12px !important;
        overflow: hidden !important;
        box-shadow:
          0 28px 72px rgba(0, 0, 0, 0.75),
          0 8px 24px rgba(0, 0, 0, 0.50),
          0 0 0 1px rgba(70, 130, 255, 0.20),
          inset 0 1px 0 rgba(255, 255, 255, 0.05) !important;
      }

      /* Pane root — CSS variable retheme */
      #map-shine-control-panel .tp-dfwv {
        --tp-base-background-color: rgba(8, 11, 22, 1.0);
        --tp-button-background-color: rgba(255, 255, 255, 0.065);
        --tp-button-background-color-active: rgba(80, 175, 255, 0.28);
        --tp-button-background-color-focus: rgba(80, 175, 255, 0.16);
        --tp-button-background-color-hover: rgba(80, 175, 255, 0.15);
        --tp-button-foreground-color: rgba(210, 232, 255, 0.90);
        --tp-container-background-color: rgba(255, 255, 255, 0.025);
        --tp-container-background-color-active: rgba(80, 175, 255, 0.12);
        --tp-container-background-color-focus: rgba(80, 175, 255, 0.08);
        --tp-container-background-color-hover: rgba(255, 255, 255, 0.04);
        --tp-container-foreground-color: rgba(215, 235, 255, 0.90);
        --tp-groove-foreground-color: rgba(90, 200, 250, 0.60);
        --tp-input-background-color: rgba(255, 255, 255, 0.065);
        --tp-input-background-color-active: rgba(80, 175, 255, 0.22);
        --tp-input-background-color-focus: rgba(80, 175, 255, 0.13);
        --tp-input-background-color-hover: rgba(255, 255, 255, 0.10);
        --tp-input-foreground-color: rgba(225, 242, 255, 0.95);
        --tp-label-foreground-color: rgba(150, 182, 225, 0.72);
        --tp-monitor-background-color: rgba(0, 0, 0, 0.22);
        --tp-monitor-foreground-color: rgba(175, 210, 250, 0.85);
        width: 292px !important;
        min-width: 292px !important;
        max-width: 292px !important;
        background: rgba(8, 11, 22, 1.0) !important;
        font-family: var(--font-primary, 'Signika', 'Segoe UI', sans-serif) !important;
      }

      /* Root title bar */
      #map-shine-control-panel .tp-rotv_b {
        background: linear-gradient(135deg,
          rgba(12, 18, 46, 1.0) 0%,
          rgba(9, 14, 34, 1.0) 100%) !important;
        border-bottom: 1px solid rgba(70, 130, 255, 0.22) !important;
        padding: 0 32px 0 10px !important;
        height: 30px !important;
        min-height: 30px !important;
      }

      #map-shine-control-panel .tp-rotv_t {
        font-size: 10px !important;
        font-weight: 700 !important;
        letter-spacing: 0.12em !important;
        text-transform: uppercase !important;
        color: rgba(125, 195, 255, 0.95) !important;
      }

      /* Scrollable content area */
      #map-shine-control-panel .tp-rotv_c {
        background: rgba(8, 11, 22, 1.0) !important;
        max-height: 78vh;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: rgba(70, 140, 255, 0.30) transparent;
      }

      #map-shine-control-panel .tp-rotv_c::-webkit-scrollbar { width: 3px; }
      #map-shine-control-panel .tp-rotv_c::-webkit-scrollbar-track { background: transparent; }
      #map-shine-control-panel .tp-rotv_c::-webkit-scrollbar-thumb {
        background: rgba(70, 140, 255, 0.32);
        border-radius: 2px;
      }
      #map-shine-control-panel .tp-rotv_c::-webkit-scrollbar-thumb:hover {
        background: rgba(90, 200, 250, 0.50);
      }

      /* Blade rows — ultra-tight */
      #map-shine-control-panel .tp-bldv {
        margin: 0 !important;
        border-bottom: 1px solid rgba(255, 255, 255, 0.030) !important;
      }

      /* Label rows */
      #map-shine-control-panel .tp-lblv {
        padding: 0 8px !important;
        min-height: 22px !important;
        height: 22px !important;
      }

      #map-shine-control-panel .tp-lblv_l {
        font-size: 10px !important;
        min-width: 76px !important;
        max-width: 96px !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        color: rgba(150, 182, 225, 0.72) !important;
      }

      /* Top-level folder headers (direct children of content area) */
      #map-shine-control-panel .tp-rotv_c > .tp-fldv > .tp-fldv_b {
        background: linear-gradient(90deg,
          rgba(14, 24, 58, 0.98) 0%,
          rgba(10, 18, 44, 0.98) 100%) !important;
        border-bottom: 1px solid rgba(70, 130, 255, 0.22) !important;
        padding: 0 10px 0 12px !important;
        height: 27px !important;
        min-height: 27px !important;
        position: relative;
      }

      /* Accent left-border on top-level folders */
      #map-shine-control-panel .tp-rotv_c > .tp-fldv > .tp-fldv_b::before {
        content: '';
        position: absolute;
        left: 0;
        top: 4px;
        bottom: 4px;
        width: 2px;
        background: linear-gradient(180deg, rgba(90, 200, 250, 0.90), rgba(60, 140, 255, 0.75));
        border-radius: 0 2px 2px 0;
      }

      #map-shine-control-panel .tp-rotv_c > .tp-fldv > .tp-fldv_b:hover {
        background: linear-gradient(90deg,
          rgba(20, 34, 74, 0.98) 0%,
          rgba(16, 26, 60, 0.98) 100%) !important;
      }

      #map-shine-control-panel .tp-rotv_c > .tp-fldv > .tp-fldv_b .tp-fldv_t {
        font-size: 9.5px !important;
        font-weight: 700 !important;
        letter-spacing: 0.09em !important;
        text-transform: uppercase !important;
        color: rgba(125, 192, 255, 0.95) !important;
      }

      /* Level 2 nested folder headers */
      #map-shine-control-panel .tp-fldv .tp-fldv .tp-fldv_b {
        background: rgba(255, 255, 255, 0.022) !important;
        border-bottom: 1px solid rgba(255, 255, 255, 0.05) !important;
        padding: 0 8px 0 10px !important;
        height: 22px !important;
        min-height: 22px !important;
      }

      #map-shine-control-panel .tp-fldv .tp-fldv .tp-fldv_b:hover {
        background: rgba(70, 145, 255, 0.07) !important;
      }

      #map-shine-control-panel .tp-fldv .tp-fldv .tp-fldv_b .tp-fldv_t {
        font-size: 9px !important;
        font-weight: 600 !important;
        letter-spacing: 0.05em !important;
        text-transform: uppercase !important;
        color: rgba(152, 183, 230, 0.80) !important;
      }

      /* Level 3+ deeply nested folder headers */
      #map-shine-control-panel .tp-fldv .tp-fldv .tp-fldv .tp-fldv_b {
        height: 20px !important;
        min-height: 20px !important;
        background: rgba(255, 255, 255, 0.013) !important;
      }

      #map-shine-control-panel .tp-fldv .tp-fldv .tp-fldv .tp-fldv_b .tp-fldv_t {
        font-size: 8.5px !important;
        color: rgba(140, 168, 215, 0.72) !important;
      }

      /* Expand arrow — dim */
      #map-shine-control-panel .tp-fldv_m {
        opacity: 0.45 !important;
      }

      /* Ultra-tight gap between sibling folders */
      #map-shine-control-panel .tp-fldv + .tp-fldv { margin-top: 0 !important; }
      #map-shine-control-panel .tp-fldv { margin-bottom: 0 !important; }

      /* ── Sliders ── */
      #map-shine-control-panel .tp-sldv {
        height: 22px !important;
        display: flex;
        align-items: center;
      }

      #map-shine-control-panel .tp-sldv_t {
        height: 2px !important;
        border-radius: 2px !important;
        background: rgba(255, 255, 255, 0.12) !important;
      }

      /* Track fill colour via groove var */
      #map-shine-control-panel .tp-sldv_t::before {
        background: linear-gradient(90deg,
          rgba(55, 155, 255, 0.85) 0%,
          rgba(90, 200, 250, 0.85) 100%) !important;
        border-radius: 2px !important;
      }

      /* ── Buttons ── */
      #map-shine-control-panel .tp-btnv_b {
        height: 22px !important;
        padding: 0 10px !important;
        font-size: 10px !important;
        font-weight: 600 !important;
        border-radius: 5px !important;
        letter-spacing: 0.02em !important;
        transition: background 0.12s, border-color 0.12s, color 0.12s !important;
      }

      /* ── Button grids ── */
      #map-shine-control-panel .tp-btngridv_b {
        font-size: 9.5px !important;
        height: 22px !important;
        font-weight: 600 !important;
        border-radius: 4px !important;
        letter-spacing: 0.02em !important;
      }

      /* ── Dropdowns ── */
      #map-shine-control-panel .tp-lstv_s {
        font-size: 10px !important;
        height: 20px !important;
        padding: 0 4px !important;
        border-radius: 4px !important;
      }

      /* ── Checkboxes ── */
      #map-shine-control-panel .tp-ckbv_w {
        width: 28px !important;
        height: 14px !important;
        border-radius: 7px !important;
      }

      #map-shine-control-panel .tp-ckbv_k {
        width: 10px !important;
        height: 10px !important;
      }

      /* ── Number / text inputs ── */
      #map-shine-control-panel .tp-nmbv_i,
      #map-shine-control-panel .tp-txtv_i {
        font-size: 10px !important;
        height: 20px !important;
        padding: 0 6px !important;
        border-radius: 4px !important;
      }

      /* ── Separators ── */
      #map-shine-control-panel .tp-brkv {
        border-top: 1px solid rgba(255, 255, 255, 0.06) !important;
        margin: 3px 8px !important;
      }

      /* ── Tab views ── */
      #map-shine-control-panel .tp-tabv_b {
        font-size: 9.5px !important;
        height: 24px !important;
        font-weight: 600 !important;
        letter-spacing: 0.04em !important;
      }

      /* ── Monitor / read-only ── */
      #map-shine-control-panel .tp-mntv_v,
      #map-shine-control-panel .tp-mntv_g {
        font-size: 10px !important;
      }

      /* ── Map Shine folder-tag chips — keep legible at compressed height ── */
      #map-shine-control-panel .map-shine-folder-tag,
      #map-shine-control-panel .map-shine-effects-count-tag {
        font-size: 8px !important;
        padding: 0 4px !important;
        min-height: 12px !important;
        line-height: 12px !important;
        border-radius: 3px !important;
      }

      /* Live Weather Overrides — native range + number (not Tweakpane bindings) */
      #map-shine-control-panel .map-shine-live-wx {
        padding: 4px 6px 6px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      #map-shine-control-panel .map-shine-live-wx-row {
        display: grid;
        grid-template-columns: 76px 1fr 44px;
        align-items: center;
        gap: 6px;
        min-height: 22px;
      }
      #map-shine-control-panel .map-shine-live-wx-lbl {
        font-size: 10px;
        color: rgba(150, 182, 225, 0.78);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #map-shine-control-panel .map-shine-live-wx-row input[type="range"] {
        width: 100%;
        height: 4px;
        accent-color: rgba(80, 175, 255, 0.95);
        cursor: pointer;
      }
      #map-shine-control-panel .map-shine-live-wx-num {
        width: 100%;
        font-size: 10px;
        height: 20px;
        padding: 0 4px;
        border-radius: 4px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.065);
        color: rgba(225, 242, 255, 0.95);
        box-sizing: border-box;
      }
    `;
    document.head.appendChild(style);
  }

  _buildRapidWeatherOverrides(parentFolder) {
    this._ensureDirectedCustomPreset();

    this._liveWeatherOverrideFolder = parentFolder.addFolder({
      title: '🎚️ Live Weather Overrides',
      expanded: true
    });

    this._wireLiveWeatherOverrideBindingsIfReady();
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
        row.range.valueAsNumber = value;
        row.number.valueAsNumber = value;
      }
    } finally {
      this._suppressLiveWeatherDomEvents = false;
    }
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

    const wc = resolveWeatherController();
    this._applyingRapidOverrides = true;
    try {
      this._forceDirectedCustomWeatherMode();
      if (wc) {
        applyWeatherManualParam(wc, paramId, value, { syncMainTweakpane: true });
      }
      this._lastWeatherControlFingerprint = this._weatherControlFingerprint();
      this._updateWeatherControls();
    } finally {
      this._applyingRapidOverrides = false;
    }

    this._mirrorLiveWeatherDomPair(paramId, value);
    if (opts.save) this.debouncedSave();
  }

  /**
   * Push `directedCustomPreset` into the native Live Weather controls (after WC sync / load).
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
   * Build plain-DOM range+number rows under the Live Weather Overrides folder (not Tweakpane `addBinding`).
   * Idempotent; also callable from `tweakpane-manager` after weather registers.
   */
  _wireLiveWeatherOverrideBindingsIfReady() {
    if (this._liveWeatherOverrideDomBuilt) return;

    const folder = this._liveWeatherOverrideFolder;
    if (!folder) return;

    this._ensureDirectedCustomPreset();
    const preset = this.controlState.directedCustomPreset;
    if (!preset || typeof preset !== 'object') return;

    this._sanitizeDirectedCustomPresetNumbers(preset);
    this._rapidWeatherBindingTarget = preset;

    const contentEl = folder.element.querySelector('.tp-fldv_c') || folder.element;
    const root = document.createElement('div');
    root.className = 'map-shine-live-wx';
    root.dataset.msLiveWx = '1';

    /** @type {Record<string, { range: HTMLInputElement, number: HTMLInputElement }>} */
    const rows = {};

    const specs = [
      { id: 'precipitation', label: 'Rain', min: 0, max: 1, step: 0.01 },
      { id: 'cloudCover', label: 'Clouds', min: 0, max: 1, step: 0.01 },
      { id: 'freezeLevel', label: 'Temp (Freeze)', min: 0, max: 1, step: 0.01 },
      { id: 'windSpeed', label: 'Wind', min: 0, max: 1, step: 0.01 },
      { id: 'windDirection', label: 'Wind Dir', min: 0, max: 359, step: 1 }
    ];

    for (const spec of specs) {
      const rowEl = document.createElement('div');
      rowEl.className = 'map-shine-live-wx-row';

      const lbl = document.createElement('span');
      lbl.className = 'map-shine-live-wx-lbl';
      lbl.textContent = spec.label;
      lbl.title = spec.label;

      const range = document.createElement('input');
      range.type = 'range';
      range.min = String(spec.min);
      range.max = String(spec.max);
      range.step = String(spec.step);
      range.setAttribute('aria-label', spec.label);

      const num = document.createElement('input');
      num.type = 'number';
      num.className = 'map-shine-live-wx-num';
      num.min = String(spec.min);
      num.max = String(spec.max);
      num.step = String(spec.step);
      num.setAttribute('aria-label', `${spec.label} value`);

      const pid = spec.id;
      range.addEventListener('input', () => {
        const v = range.valueAsNumber;
        if (!Number.isFinite(v)) return;
        this._commitLiveWeatherOverrideScalar(pid, v, { save: false });
      });
      range.addEventListener('change', () => {
        this.debouncedSave();
      });

      num.addEventListener('input', () => {
        const v = parseFloat(num.value);
        if (!Number.isFinite(v)) return;
        this._commitLiveWeatherOverrideScalar(pid, v, { save: false });
      });
      num.addEventListener('change', () => {
        const v = parseFloat(num.value);
        if (Number.isFinite(v)) {
          this._commitLiveWeatherOverrideScalar(pid, v, { save: false });
        }
        this.debouncedSave();
      });

      rowEl.appendChild(lbl);
      rowEl.appendChild(range);
      rowEl.appendChild(num);
      root.appendChild(rowEl);

      rows[pid] = { range, number: num };
    }

    contentEl.appendChild(root);
    this._liveWeatherOverrideDom = { root, rows };
    this._liveWeatherOverrideDomBuilt = true;

    try {
      hydrateControlPanelLiveOverridesFromController(resolveWeatherController());
    } catch (_) {}
    this.syncLiveWeatherOverrideDomFromDirectedPreset();
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
      try {
        this.pane?.refresh?.();
      } catch (_) {
      }
    } catch (error) {
      log.error('Failed to apply rapid weather overrides:', error);
    } finally {
      this._applyingRapidOverrides = false;
    }
  }

  _buildStatusPanel() {
    if (!this.pane?.element) return;
    if (this.statusPanel) return;

    if (!document.getElementById('map-shine-control-status-style')) {
      const style = document.createElement('style');
      style.id = 'map-shine-control-status-style';
      style.textContent = `
        @keyframes mapShineIndeterminate {
          0% { transform: translateX(-60%); }
          100% { transform: translateX(160%); }
        }
        .ms-status-mode-badge {
          display: inline-flex;
          align-items: center;
          padding: 1px 5px;
          border-radius: 3px;
          font-size: 8.5px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          white-space: nowrap;
          flex-shrink: 0;
        }
        .ms-status-mode-badge--dynamic {
          background: rgba(80, 175, 255, 0.18);
          color: rgba(140, 210, 255, 0.95);
          border: 1px solid rgba(80, 175, 255, 0.28);
        }
        .ms-status-mode-badge--directed {
          background: rgba(160, 110, 255, 0.18);
          color: rgba(200, 170, 255, 0.95);
          border: 1px solid rgba(160, 110, 255, 0.28);
        }
        .ms-status-mode-badge--off {
          background: rgba(255, 255, 255, 0.07);
          color: rgba(180, 190, 210, 0.75);
          border: 1px solid rgba(255, 255, 255, 0.10);
        }
      `;
      document.head.appendChild(style);
    }

    const FF = 'system-ui, -apple-system, "Segoe UI", sans-serif';

    /* Outer panel strip */
    const panel = document.createElement('div');
    panel.style.padding = '5px 8px 6px';
    panel.style.background = 'rgba(10, 14, 32, 0.90)';
    panel.style.borderBottom = '1px solid rgba(60, 110, 255, 0.14)';
    panel.style.fontFamily = FF;
    panel.style.fontSize = '10px';
    panel.style.lineHeight = '1.3';
    panel.style.color = 'rgba(195, 220, 255, 0.88)';

    /* Top row: mode badge + activity description */
    const topRow = document.createElement('div');
    topRow.style.display = 'flex';
    topRow.style.alignItems = 'center';
    topRow.style.gap = '6px';
    topRow.style.minHeight = '16px';

    const modeText = document.createElement('span');
    modeText.className = 'ms-status-mode-badge ms-status-mode-badge--off';

    const activityText = document.createElement('span');
    activityText.style.flex = '1';
    activityText.style.overflow = 'hidden';
    activityText.style.textOverflow = 'ellipsis';
    activityText.style.whiteSpace = 'nowrap';
    activityText.style.fontSize = '9.5px';
    activityText.style.opacity = '0.78';

    topRow.appendChild(modeText);
    topRow.appendChild(activityText);
    panel.appendChild(topRow);

    /* Stats row: current | target | scope — compact inline */
    const statsRow = document.createElement('div');
    statsRow.style.display = 'flex';
    statsRow.style.gap = '6px';
    statsRow.style.marginTop = '3px';
    statsRow.style.fontSize = '9px';
    statsRow.style.opacity = '0.65';
    statsRow.style.overflow = 'hidden';

    const curText = document.createElement('span');
    curText.style.flex = '1';
    curText.style.overflow = 'hidden';
    curText.style.textOverflow = 'ellipsis';
    curText.style.whiteSpace = 'nowrap';

    const tgtText = document.createElement('span');
    tgtText.style.flex = '1';
    tgtText.style.overflow = 'hidden';
    tgtText.style.textOverflow = 'ellipsis';
    tgtText.style.whiteSpace = 'nowrap';
    tgtText.style.opacity = '0.80';

    const scopeText = document.createElement('span');
    scopeText.style.display = 'none'; // Hidden — scope tracked internally

    statsRow.appendChild(curText);
    statsRow.appendChild(tgtText);
    panel.appendChild(statsRow);

    /* Slim progress bar — hidden when not transitioning */
    const progressWrap = document.createElement('div');
    progressWrap.style.display = 'none';
    progressWrap.style.marginTop = '5px';

    const progressMeta = document.createElement('div');
    progressMeta.style.display = 'flex';
    progressMeta.style.justifyContent = 'space-between';
    progressMeta.style.marginBottom = '3px';
    progressMeta.style.fontSize = '8.5px';
    progressMeta.style.opacity = '0.65';

    const progressLabel = document.createElement('span');
    const progressPct = document.createElement('span');
    progressMeta.appendChild(progressLabel);
    progressMeta.appendChild(progressPct);

    const barOuter = document.createElement('div');
    barOuter.style.height = '2px';
    barOuter.style.borderRadius = '999px';
    barOuter.style.background = 'rgba(255,255,255,0.08)';
    barOuter.style.overflow = 'hidden';

    const barInner = document.createElement('div');
    barInner.style.height = '100%';
    barInner.style.width = '0%';
    barInner.style.background = 'linear-gradient(90deg, rgba(55,155,255,0.90), rgba(90,200,250,0.90))';
    barInner.style.transition = 'width 120ms linear';
    barInner.style.borderRadius = '999px';
    barOuter.appendChild(barInner);

    progressWrap.appendChild(progressMeta);
    progressWrap.appendChild(barOuter);
    panel.appendChild(progressWrap);

    this.statusPanel = panel;
    this._statusEls = {
      curText,
      tgtText,
      modeText,
      activityText,
      scopeText,
      progressLabel,
      progressPct,
      barInner,
      progressWrap
    };

    // Insert directly under the pane title bar.
    const root = this.pane.element;
    root.insertBefore(panel, root.firstChild?.nextSibling ?? root.firstChild);

    this._updateStatusPanel();
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

      if (this._isMinimized && this._minimizedButton) {
        state.left = this._readPx(this._minimizedButton.style.left);
        state.top = this._readPx(this._minimizedButton.style.top);
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

    if (state.minimized === true) {
      const x = Number.isFinite(left) ? left : 20;
      const y = Number.isFinite(top) ? top : 20;
      this._showMinimizedButtonAt(x, y);
      this._isMinimized = true;
      this.container.style.display = 'none';
      this.visible = false;
    }
  }

  _createMinimizeControls(parentElement = document.body) {
    if (!this.container || !this.headerOverlay) return;

    /* ─── In-panel minimize button (top-right of title bar) ─── */
    const minimizeButton = document.createElement('button');
    minimizeButton.type = 'button';
    minimizeButton.title = 'Minimize panel';
    minimizeButton.textContent = '−';
    minimizeButton.style.cssText = [
      'position:absolute',
      'right:6px',
      'top:50%',
      'transform:translateY(-50%)',
      'width:18px',
      'height:18px',
      'border:1px solid rgba(255,255,255,0.16)',
      'border-radius:4px',
      'background:rgba(0,0,0,0.30)',
      'color:rgba(200,225,255,0.85)',
      'cursor:pointer',
      'line-height:16px',
      'padding:0',
      'font-size:14px',
      'font-weight:300',
      'z-index:10002',
      'transition:background 0.12s,border-color 0.12s,color 0.12s'
    ].join(';');
    minimizeButton.addEventListener('mouseenter', () => {
      minimizeButton.style.background = 'rgba(255,80,80,0.22)';
      minimizeButton.style.borderColor = 'rgba(255,100,100,0.45)';
      minimizeButton.style.color = 'rgba(255,200,200,0.95)';
    });
    minimizeButton.addEventListener('mouseleave', () => {
      minimizeButton.style.background = 'rgba(0,0,0,0.30)';
      minimizeButton.style.borderColor = 'rgba(255,255,255,0.16)';
      minimizeButton.style.color = 'rgba(200,225,255,0.85)';
    });
    minimizeButton.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    minimizeButton.addEventListener('click', this._boundHandlers.onMinimizeButtonClick);
    this.headerOverlay.appendChild(minimizeButton);
    this._minimizeButton = minimizeButton;

    /* ─── Floating restore icon (shown when minimized) ─── */
    const minimizedButton = document.createElement('button');
    minimizedButton.type = 'button';
    minimizedButton.title = 'Open Map Shine Control';
    minimizedButton.textContent = '🎛️';
    minimizedButton.style.cssText = [
      'position:fixed',
      'left:20px',
      'top:20px',
      'width:32px',
      'height:32px',
      'border:1px solid rgba(70,130,255,0.35)',
      'border-radius:999px',
      'background:rgba(8,11,22,0.88)',
      'box-shadow:0 4px 16px rgba(0,0,0,0.55),0 0 0 1px rgba(70,130,255,0.18)',
      'color:rgba(255,255,255,0.95)',
      'cursor:pointer',
      'display:none',
      'z-index:10001',
      'padding:0',
      'line-height:1',
      'font-size:15px',
      'transition:box-shadow 0.15s,border-color 0.15s,background 0.15s'
    ].join(';');
    minimizedButton.addEventListener('mouseenter', () => {
      minimizedButton.style.background = 'rgba(14,20,50,0.95)';
      minimizedButton.style.borderColor = 'rgba(90,200,250,0.55)';
      minimizedButton.style.boxShadow = '0 6px 24px rgba(0,0,0,0.60),0 0 0 1px rgba(90,200,250,0.28)';
    });
    minimizedButton.addEventListener('mouseleave', () => {
      minimizedButton.style.background = 'rgba(8,11,22,0.88)';
      minimizedButton.style.borderColor = 'rgba(70,130,255,0.35)';
      minimizedButton.style.boxShadow = '0 4px 16px rgba(0,0,0,0.55),0 0 0 1px rgba(70,130,255,0.18)';
    });
    minimizedButton.addEventListener('click', this._boundHandlers.onMinimizedBadgeClick);
    parentElement.appendChild(minimizedButton);
    this._minimizedButton = minimizedButton;
  }

  _showMinimizedButtonAt(left, top) {
    if (!this._minimizedButton) return;
    const pad = 8;
    const width = this._minimizedButton.offsetWidth || 28;
    const height = this._minimizedButton.offsetHeight || 28;
    const maxLeft = Math.max(pad, window.innerWidth - (width + pad));
    const maxTop = Math.max(pad, window.innerHeight - (height + pad));
    const x = Math.max(pad, Math.min(maxLeft, Number(left) || pad));
    const y = Math.max(pad, Math.min(maxTop, Number(top) || pad));
    this._minimizedButton.style.left = `${x}px`;
    this._minimizedButton.style.top = `${y}px`;
    this._minimizedButton.style.display = 'block';
  }

  _hideMinimizedButton() {
    if (!this._minimizedButton) return;
    this._minimizedButton.style.display = 'none';
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
    this._minimizeToIcon();
  }

  _onMinimizedBadgeClick(e) {
    e.preventDefault();
    e.stopPropagation();
    this.show();
  }

  _minimizeToIcon() {
    if (!this.container) return;

    const anchor = this._getPanelAnchorPosition();
    this.container.style.display = 'none';
    this.visible = false;
    this._isMinimized = true;
    this._showMinimizedButtonAt(anchor.left, anchor.top);

    if (this._statusIntervalId) {
      clearInterval(this._statusIntervalId);
      this._statusIntervalId = null;
    }

    this._saveControlPanelUIState();
  }

  _formatWeatherLine(state) {
    if (!state) return '—';
    const pct = (v) => `${Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 100)}%`;
    const windMS = (() => {
      const ws = Number(state.windSpeed);
      return (Number.isFinite(ws) && ws > 0.01) ? ws * 78 : (Number(state.windSpeedMS) || 0);
    })();
    const freeze = Math.max(0, Math.min(1, Number(state.freezeLevel) || 0));
    const tempLabel = freeze > 0.75 ? 'Snow' : freeze > 0.45 ? 'Sleet' : 'Rain';
    /* Short single-line summary for compact status strip */
    return `${tempLabel} · Rain ${pct(state.precipitation)} · ` +
           `Clouds ${pct(state.cloudCover)} · Wind ${Math.round(windMS)}m/s`;
  }

  _updateStatusPanel() {
    const els = this._statusEls;
    if (!els) return;

    const wc = coreWeatherController || window.MapShine?.weatherController || window.weatherController;
    const isGM = game.user?.isGM === true;
    els.scopeText.textContent = isGM ? 'Scene (GM authoritative)' : 'Runtime only';

    if (!wc) {
      els.modeText.className = 'ms-status-mode-badge ms-status-mode-badge--off';
      els.modeText.textContent = 'Unavailable';
      els.activityText.textContent = '';
      els.curText.textContent = 'WeatherController not available';
      els.tgtText.textContent = '—';
      els.progressWrap.style.display = 'none';
      return;
    }

    this._updateTimeUI(wc);
    this._updateWindUI(wc);
    this._syncTileMotionSpeedFromManager();

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
      const spd = dynamicSpeed !== null ? `, Speed ${Math.round(dynamicSpeed)}x` : '';
      els.activityText.textContent = `${dynamicPreset}${spd}`;
    } else {
      els.activityText.textContent = '';
    }

    const cur = wc.getCurrentState?.() ?? wc.currentState;
    const tgt = wc.targetState;

    if (!isEnabled) {
      els.curText.textContent = 'Weather disabled';
      els.tgtText.textContent = '';
      els.tgtText.style.display = 'none';
      els.progressWrap.style.display = 'none';
      els.barInner.style.animation = 'none';
      els.barInner.style.width = '0%';
      return;
    }

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

  async _startTimeOfDayTransition(targetHour, transitionMinutes) {
    try {
      const minsNum = typeof transitionMinutes === 'number' ? transitionMinutes : Number(transitionMinutes);
      const safeMinutes = Number.isFinite(minsNum) ? Math.max(0.1, Math.min(60.0, minsNum)) : 5.0;

      // Persist immediately so other clients can't overwrite with old state mid-transition.
      this.controlState.timeOfDay = ((targetHour % 24) + 24) % 24;
      await this._saveControlState();

      await stateApplier.startTimeOfDayTransition(this.controlState.timeOfDay, safeMinutes, true, false);
      this._updateClockTarget(this.controlState.timeOfDay);
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
    if (this.pane) {
      log.warn('ControlPanelManager already initialized');
      return;
    }

    const _dlp = debugLoadingProfiler;
    const _isDbg = _dlp.debugMode;

    // Wait for Tweakpane to be available
    if (_isDbg) _dlp.begin('cp.waitForLib', 'finalize');
    const startTime = Date.now();
    while (typeof Tweakpane === 'undefined' && (Date.now() - startTime) < 5000) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (_isDbg) _dlp.end('cp.waitForLib');

    if (typeof Tweakpane === 'undefined') {
      throw new Error('Tweakpane library not available');
    }

    log.info('Initializing Control Panel...');

    this._injectPanelStyles();

    // Create container
    this.container = document.createElement('div');
    this.container.id = 'map-shine-control-panel';
    this.container.style.position = 'fixed';
    this.container.style.zIndex = '9999'; // Below config panel (10000)
    this.container.style.left = '50%';
    this.container.style.top = '50%';
    this.container.style.transform = 'translate(-50%, -50%)';
    this.container.style.display = 'none'; // Initially hidden
    this.container.style.borderRadius = '12px';
    this.container.style.overflow = 'hidden';
    this.container.style.width = '292px';
    this.container.style.maxWidth = '292px';
    parentElement.appendChild(this.container);

    {
      const stop = (e) => {
        try {
          e.stopPropagation();
        } catch (_) {
        }
      };

      const stopAndPrevent = (e) => {
        try {
          e.preventDefault();
        } catch (_) {
        }
        stop(e);
      };

      const events = [
        'pointerdown',
        'mousedown',
        'click',
        'dblclick',
        'wheel'
      ];

      for (const type of events) {
        if (type === 'wheel') this.container.addEventListener(type, stop, { passive: true });
        else this.container.addEventListener(type, stop);
      }

      this.container.addEventListener('contextmenu', stopAndPrevent);
    }

    // Create pane
    this.pane = new Tweakpane.Pane({
      title: 'Map Shine Control',
      container: this.container,
      expanded: true
    });

    // Create a transparent header overlay for dragging.
    this.headerOverlay = document.createElement('div');
    this.headerOverlay.className = 'map-shine-control-header-overlay';
    this.headerOverlay.style.position = 'absolute';
    this.headerOverlay.style.top = '0';
    this.headerOverlay.style.left = '0';
    this.headerOverlay.style.right = '0';
    this.headerOverlay.style.height = '24px';
    this.headerOverlay.style.pointerEvents = 'auto';
    this.headerOverlay.style.cursor = 'move';
    this.headerOverlay.style.background = 'transparent';
    this.headerOverlay.style.zIndex = '10000';
    this.headerOverlay.addEventListener('mousedown', this._boundHandlers.onHeaderMouseDown);
    this.container.appendChild(this.headerOverlay);

    this._createMinimizeControls(parentElement);

    this._buildStatusPanel();

    this._applyControlPanelUIState(this._loadControlPanelUIState());

    // Load saved control state
    if (_isDbg) _dlp.begin('cp.loadControlState', 'finalize');
    this._didLoadControlState = await this._loadControlState();
    if (_isDbg) _dlp.end('cp.loadControlState');

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

    // Build UI sections
    if (_isDbg) _dlp.begin('cp.buildSections', 'finalize');
    this._buildPhaseALayout();
    if (_isDbg) _dlp.end('cp.buildSections');

    // Apply initial state
    if (_isDbg) _dlp.begin('cp.applyControlState', 'finalize');
    await this._applyControlState();
    if (_isDbg) _dlp.end('cp.applyControlState');

    try {
      hydrateControlPanelLiveOverridesFromController(resolveWeatherController());
      this.syncLiveWeatherOverrideDomFromDirectedPreset();
    } catch (_) {}

    this._registerFoundryTimeHook();

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
    try {
      this.pane?.refresh?.();
    } catch (_) {
    }

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
   * Build the Time of Day section with custom clock
   * @private
   */
  _buildTimeSection(parentFolder = this.pane, options = undefined) {
    const targetFolder = parentFolder || this.pane;
    const timeFolder = targetFolder.addFolder({
      title: options?.title ?? '⏰ Time Director',
      expanded: options?.expanded ?? true
    });
    if (options?.registerTopLevel !== false && targetFolder === this.pane) this._registerTopLevelFolder(timeFolder);
    this._ensureFolderTag(timeFolder, 'time', 'Now');

    const refreshTimeFolderTag = () => {
      const mins = Number(this.controlState.timeTransitionMinutes) || 0;
      if (this.controlState.linkTimeToFoundry) {
        this._setFolderTag('time', 'Foundry Lock');
      } else if (mins > 0) {
        this._setFolderTag('time', `${mins.toFixed(1)} min`);
      } else {
        this._setFolderTag('time', 'Now');
      }
    };

    this.clockElement = this._createClockDOM();

    /* Two-column layout: clock left, controls right */
    const twoCol = document.createElement('div');
    twoCol.style.cssText = 'display:flex;gap:6px;padding:6px 6px 5px;align-items:flex-start;';

    /* Left: clock */
    const clockWrap = document.createElement('div');
    clockWrap.style.flexShrink = '0';
    clockWrap.appendChild(this.clockElement);

    /* Right: controls column */
    const ctrlWrap = document.createElement('div');
    ctrlWrap.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;padding-top:1px;';

    /* 2×2 quick-time buttons */
    const quickTimes = this._getQuickTimeAnchors();
    const btnGrid = document.createElement('div');
    btnGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:3px;';

    for (const [label, hour] of Object.entries(quickTimes)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.style.cssText = [
        'padding:5px 3px',
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
        btn.style.background = 'rgba(80,170,255,0.16)';
        btn.style.borderColor = 'rgba(80,170,255,0.38)';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.background = 'rgba(255,255,255,0.06)';
        btn.style.borderColor = 'rgba(255,255,255,0.12)';
      });
      btn.addEventListener('click', () => {
        this._revealTimeTargetUI();
        const mins = Number(this.controlState.timeTransitionMinutes) || 0;
        if (mins > 0) {
          void this._startTimeOfDayTransition(hour, mins).then(() => this.debouncedSave());
        } else {
          void this._setTimeOfDay(hour).then(() => this.debouncedSave());
        }
      });
      btnGrid.appendChild(btn);
    }
    ctrlWrap.appendChild(btnGrid);

    /* Thin separator */
    const sep = document.createElement('div');
    sep.style.cssText = 'border-top:1px solid rgba(255,255,255,0.06);margin:1px 0;';
    ctrlWrap.appendChild(sep);

    /* Transition row: label + number input */
    const transRow = document.createElement('div');
    transRow.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:9.5px;color:rgba(155,185,225,0.75);';

    const transLabel = document.createElement('span');
    transLabel.textContent = 'Transition';
    transLabel.style.flexShrink = '0';

    const transInput = document.createElement('input');
    transInput.type = 'number';
    transInput.min = '0';
    transInput.max = '60';
    transInput.step = '0.5';
    transInput.value = String(this.controlState.timeTransitionMinutes ?? 0);
    transInput.style.cssText = [
      'flex:1',
      'min-width:0',
      'height:18px',
      'padding:0 4px',
      'border:1px solid rgba(255,255,255,0.12)',
      'border-radius:4px',
      'background:rgba(255,255,255,0.07)',
      'color:rgba(220,238,255,0.92)',
      'font-size:9.5px',
      'font-family:inherit',
      'outline:none',
      'transition:border-color 0.12s,background 0.12s'
    ].join(';');
    transInput.addEventListener('change', () => {
      this.controlState.timeTransitionMinutes = Math.max(0, Math.min(60, Number(transInput.value) || 0));
      transInput.value = String(this.controlState.timeTransitionMinutes);
      refreshTimeFolderTag();
      this.debouncedSave();
    });
    transInput.addEventListener('focus', () => {
      transInput.style.borderColor = 'rgba(90,200,250,0.45)';
      transInput.style.background = 'rgba(90,200,250,0.10)';
    });
    transInput.addEventListener('blur', () => {
      transInput.style.borderColor = 'rgba(255,255,255,0.12)';
      transInput.style.background = 'rgba(255,255,255,0.07)';
    });
    this._timeTransitionInput = transInput;

    transRow.appendChild(transLabel);
    transRow.appendChild(transInput);
    ctrlWrap.appendChild(transRow);

    /* Link-to-Foundry checkbox row */
    const linkRow = document.createElement('label');
    linkRow.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:5px',
      'cursor:pointer',
      'font-size:9.5px',
      'color:rgba(155,185,225,0.75)',
      'user-select:none'
    ].join(';');
    linkRow.title = 'Lock Map Shine time to the Foundry world clock';

    const linkChk = document.createElement('input');
    linkChk.type = 'checkbox';
    linkChk.checked = this.controlState.linkTimeToFoundry === true;
    linkChk.disabled = !(game.user?.isGM === true);
    linkChk.style.cssText = 'width:12px;height:12px;cursor:pointer;flex-shrink:0;accent-color:rgba(90,200,250,1);';
    linkChk.addEventListener('change', (e) => {
      this.controlState.linkTimeToFoundry = e.target.checked;
      refreshTimeFolderTag();
      if (e.target.checked) {
        void this._syncTimeFromFoundryWorldTime(game?.time?.worldTime, false);
      }
      this.debouncedSave();
    });
    this._timeLinkCheckbox = linkChk;

    const linkLabel = document.createElement('span');
    linkLabel.textContent = 'Foundry Time Lock';
    linkRow.appendChild(linkChk);
    linkRow.appendChild(linkLabel);
    ctrlWrap.appendChild(linkRow);

    twoCol.appendChild(clockWrap);
    twoCol.appendChild(ctrlWrap);

    const contentElement = timeFolder.element.querySelector('.tp-fldv_c') || timeFolder.element;
    contentElement.appendChild(twoCol);

    refreshTimeFolderTag();
  }

  _updateCustomTimeControls() {
    if (this._timeTransitionInput) {
      this._timeTransitionInput.value = String(this.controlState.timeTransitionMinutes ?? 0);
    }
    if (this._timeLinkCheckbox) {
      this._timeLinkCheckbox.checked = this.controlState.linkTimeToFoundry === true;
    }
  }

  /**
   * Create custom clock DOM element
   * @returns {HTMLElement}
   * @private
   */
  _createClockDOM() {
    /* 120px face — all pixel values scaled from the original 180px design (scale ≈ 60/85) */
    const FACE_SIZE = 120;
    const CENTER   = 60;  // face center in px

    const container = document.createElement('div');
    container.style.cssText = 'width:120px;position:relative;flex-shrink:0;';

    const face = document.createElement('div');
    const modulePath = game?.modules?.get?.('map-shine-advanced')?.path;
    const clockBg = modulePath ? `${modulePath}/assets/clock-face.webp` : null;
    face.style.cssText = [
      `width:${FACE_SIZE}px`,
      `height:${FACE_SIZE}px`,
      'border:2px solid rgba(60,90,160,0.55)',
      'border-radius:50%',
      'position:relative',
      `background:${clockBg ? `url('${clockBg}') center/cover` : 'rgba(14,20,42,0.85)'}`,
      'cursor:crosshair',
      'box-shadow:0 0 10px rgba(0,0,0,0.45),inset 0 0 12px rgba(0,0,0,0.35)'
    ].join(';');

    /* Hour markers (24-hour, noon at top, midnight at bottom) */
    const R1_MAJOR = 47, R1_MINOR = 50, R2 = 55;
    for (let i = 0; i < 24; i++) {
      const isMajor = i % 6 === 0;
      const shifted = ((i - 12) % 24 + 24) % 24;
      const deg = shifted * 15;
      const angle = (deg - 90) * (Math.PI / 180);
      const r1 = isMajor ? R1_MAJOR : R1_MINOR;
      const x1 = CENTER + Math.cos(angle) * r1;
      const y1 = CENTER + Math.sin(angle) * r1;
      const marker = document.createElement('div');
      marker.style.cssText = [
        'position:absolute',
        `width:${isMajor ? 2 : 1}px`,
        `height:${isMajor ? 7 : 4}px`,
        `background:${isMajor ? 'rgba(180,200,255,0.55)' : 'rgba(100,130,200,0.35)'}`,
        `left:${x1.toFixed(1)}px`,
        `top:${y1.toFixed(1)}px`,
        `transform:rotate(${deg}deg)`,
        `transform-origin:${isMajor ? '1px 3.5px' : '0.5px 2px'}`
      ].join(';');
      face.appendChild(marker);
    }

    /* Time hand */
    const hand = document.createElement('div');
    hand.style.cssText = [
      'position:absolute',
      'width:2px',
      'height:46px',
      'background:#e74c3c',
      `left:${CENTER - 1}px`,
      'top:10px',
      `transform-origin:1px ${CENTER - 10}px`,
      'border-radius:2px',
      'box-shadow:0 0 3px rgba(0,0,0,0.4)',
      'pointer-events:none'
    ].join(';');

    /* Target (ghost) hand — shown when dragging to a target time */
    const targetHand = document.createElement('div');
    targetHand.style.cssText = [
      'position:absolute',
      'width:2px',
      'height:46px',
      'background:rgba(255,255,255,0.30)',
      `left:${CENTER - 1}px`,
      'top:10px',
      `transform-origin:1px ${CENTER - 10}px`,
      'border-radius:2px',
      'pointer-events:none',
      'z-index:1',
      'display:none'
    ].join(';');

    /* Center dot */
    const center = document.createElement('div');
    center.style.cssText = [
      'position:absolute',
      'width:8px',
      'height:8px',
      'background:rgba(20,28,60,0.90)',
      'border:1px solid rgba(90,200,250,0.45)',
      'border-radius:50%',
      `left:${CENTER - 4}px`,
      `top:${CENTER - 4}px`,
      'z-index:2'
    ].join(';');

    /* Wind direction arrow (stays on clock as a directional indicator) */
    const windArrow = document.createElement('div');
    windArrow.style.cssText = [
      'position:absolute',
      'left:50%',
      'top:50%',
      'width:2px',
      'height:22px',
      'background:rgba(90,200,250,0.75)',
      'transform-origin:50% 100%',
      'pointer-events:none',
      'z-index:3',
      'transform:translate(-50%,0%) rotate(0deg)'
    ].join(';');

    const windArrowHead = document.createElement('div');
    windArrowHead.style.cssText = [
      'position:absolute',
      'left:50%',
      'top:0',
      'transform:translate(-50%,-50%)',
      'width:0',
      'height:0',
      'border-left:4px solid transparent',
      'border-right:4px solid transparent',
      'border-bottom:7px solid rgba(90,200,250,0.80)'
    ].join(';');
    windArrow.appendChild(windArrowHead);

    /* Digital time (below face) */
    const digital = document.createElement('div');
    digital.style.cssText = [
      'text-align:center',
      'font-family:monospace',
      'font-size:10px',
      'font-weight:700',
      'color:rgba(215,235,255,0.88)',
      'margin-top:4px',
      'letter-spacing:0.05em'
    ].join(';');

    face.appendChild(hand);
    face.appendChild(targetHand);
    face.appendChild(center);
    face.appendChild(windArrow);
    container.appendChild(face);
    container.appendChild(digital);

    /* Store references (wind strength bar removed — wind is now in Live Weather Overrides) */
    this.clockElements = { hand, targetHand, digital, face };
    this._windArrow = windArrow;
    this._windStrengthBarInner = null;  // moved to Live Weather Overrides
    this._windStrengthText = null;      // moved to Live Weather Overrides

    /* Mouse events for dragging */
    face.addEventListener('mousedown', this._boundHandlers.onFaceMouseDown);
    document.addEventListener('mousemove', this._boundHandlers.onDocMouseMove, { capture: true });
    document.addEventListener('mouseup', this._boundHandlers.onDocMouseUp, { capture: true });

    /* Touch events */
    face.addEventListener('touchstart', this._boundHandlers.onFaceTouchStart);
    document.addEventListener('touchmove', this._boundHandlers.onDocTouchMove);
    document.addEventListener('touchend', this._boundHandlers.onDocTouchEnd);

    return container;
  }

  _revealTimeTargetUI() {
    if (this._didRevealTimeTarget) return;
    this._didRevealTimeTarget = true;
    if (this.clockElements?.targetHand) {
      this.clockElements.targetHand.style.display = '';
    }
  }

  _updateClockTarget(hour) {
    if (!this.clockElements.targetHand) return;

    // Only show the ghost hand after the first user-driven target interaction.
    if (!this._didRevealTimeTarget) return;

    const shifted = ((hour - 12) % 24 + 24) % 24;
    const angle = (shifted / 24) * 360;
    this.clockElements.targetHand.style.transform = `rotate(${angle}deg)`;
  }

  /**
   * Update clock hand position and digital display
   * @param {number} hour - 0-24 hour value
   * @private
   */
  _updateClock(hour) {
    if (!this.clockElements.hand) return;

    // 24h angle with noon at top, midnight at bottom.
    const shifted = ((hour - 12) % 24 + 24) % 24;
    const angle = (shifted / 24) * 360;
    this.clockElements.hand.style.transform = `rotate(${angle}deg)`;

    // Update digital display
    const displayHour = Math.floor(hour);
    const displayMinute = Math.floor((hour % 1) * 60);
    this.clockElements.digital.textContent = 
      `${displayHour.toString().padStart(2, '0')}:${displayMinute.toString().padStart(2, '0')}`;
  }

  /**
   * Handle mouse down on clock
   * @param {MouseEvent} e
   * @private
   */
  _onClockMouseDown(e) {
    e.preventDefault();
    this.isDraggingClock = true;
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
    this._updateTimeFromMouse(e);
  }

  /**
   * Handle mouse up
   * @private
   */
  _onClockMouseUp() {
    if (this.isDraggingClock) {
      this.isDraggingClock = false;

      const target = this._dragTimeTarget;
      this._dragTimeTarget = null;

      if (typeof target === 'number' && Number.isFinite(target)) {
        const mins = Number(this.controlState.timeTransitionMinutes) || 0;
        if (mins > 0) {
          void this._startTimeOfDayTransition(target, mins).then(() => this.debouncedSave());
        } else {
          void this._setTimeOfDay(target).then(() => this.debouncedSave());
        }
      } else {
        this.debouncedSave();
      }
    }
  }

  /**
   * Handle touch start on clock
   * @param {TouchEvent} e
   * @private
   */
  _onClockTouchStart(e) {
    e.preventDefault();
    this.isDraggingClock = true;
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

    // During drag we only preview the target.
    this._dragTimeTarget = hour24;
    this.controlState.timeOfDay = hour24;
    this._updateClockTarget(hour24);

    // Provide immediate feedback while dragging.
    const displayHour = Math.floor(hour24);
    const displayMinute = Math.floor((hour24 % 1) * 60);
    if (this.clockElements.digital) {
      this.clockElements.digital.textContent = `${displayHour.toString().padStart(2, '0')}:${displayMinute.toString().padStart(2, '0')}`;
    }
  }

  _onHeaderMouseDown(e) {
    if (!this.container) return;
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
   * Build the Weather section
   * @private
   */
  _buildWeatherSection(parentFolder = this.pane, options = undefined) {
    const targetFolder = parentFolder || this.pane;
    const weatherFolder = targetFolder.addFolder({
      title: options?.title ?? '🌦️ Weather Director',
      expanded: options?.expanded ?? false
    });
    if (options?.registerTopLevel !== false && targetFolder === this.pane) this._registerTopLevelFolder(weatherFolder);
    this._ensureFolderTag(weatherFolder, 'weather', 'Directed');

    weatherFolder.on('fold', (ev) => {
      // Keep state explicit if we later persist control-panel accordions.
      this._weatherFolderExpanded = !!ev.expanded;
    });

    // Weather mode selector
    weatherFolder.addBinding(this.controlState, 'weatherMode', {
      label: 'Mode',
      options: {
        'Dynamic': 'dynamic',
        'Directed': 'directed'
      }
    }).on('change', (ev) => {
      this.controlState.weatherMode = ev.value;

      // Make the mode toggle persist correctly across refresh by ensuring
      // the underlying dynamicEnabled flag matches the selected mode.
      // If the user picks Dynamic, dynamic weather should be enabled.
      // If the user picks Directed, dynamic weather should be disabled.
      if (ev.value === 'dynamic') {
        this.controlState.dynamicEnabled = true;
      } else {
        this.controlState.dynamicEnabled = false;
      }

      this._updateWeatherControls();
      void this._applyControlState();
      this.debouncedSave();
    });

    this._weatherDynamicFolder = weatherFolder.addFolder({
      title: 'Dynamic Mode',
      expanded: this.controlState.weatherMode === 'dynamic'
    });
    this.dynamicControls = this._buildDynamicControls(this._weatherDynamicFolder);

    this._weatherDirectedFolder = weatherFolder.addFolder({
      title: 'Directed Mode',
      expanded: this.controlState.weatherMode === 'directed'
    });
    this.directedControls = this._buildDirectedControls(this._weatherDirectedFolder);

    // Show/hide appropriate controls based on current mode
    this._updateWeatherControls();
  }

  /**
   * Build dynamic weather controls
   * @param {Tweakpane.Folder} parentFolder
   * @returns {Object} Control references
   * @private
   */
  _buildDynamicControls(parentFolder) {
    const controls = {};

    controls.enabled = parentFolder.addBinding(this.controlState, 'dynamicEnabled', {
      label: 'Dynamic Weather'
    }).on('change', (ev) => {
      void this._applyControlState();
      if (ev?.last) this.debouncedSave();
    });

    controls.preset = parentFolder.addBinding(this.controlState, 'dynamicPresetId', {
      label: 'Biome',
      options: {
        'Temperate Plains': 'Temperate Plains',
        'Desert': 'Desert',
        'Tropical Jungle': 'Tropical Jungle',
        'Tundra': 'Tundra',
        'Arctic Blizzard': 'Arctic Blizzard'
      }
    }).on('change', (ev) => {
      void this._applyControlState();
      if (ev?.last) this.debouncedSave();
    });

    controls.speed = parentFolder.addBinding(this.controlState, 'dynamicEvolutionSpeed', {
      label: 'Speed (x)',
      min: 0,
      max: 600,
      step: 1
    }).on('change', (ev) => {
      void this._applyControlState();
      if (ev?.last) this.debouncedSave();
    });

    controls.paused = parentFolder.addBinding(this.controlState, 'dynamicPaused', {
      label: 'Pause Evolution'
    }).on('change', (ev) => {
      void this._applyControlState();
      if (ev?.last) this.debouncedSave();
    });

    return controls;
  }

  /**
   * Build directed weather controls
   * @param {Tweakpane.Folder} parentFolder
   * @returns {Object} Control references
   * @private
   */
  _buildDirectedControls(parentFolder) {
    const controls = {};

    controls.preset = parentFolder.addBinding(this.controlState, 'directedPresetId', {
      label: 'Weather',
      options: {
        'Custom': 'Custom',
        'Clear (Dry)': 'Clear (Dry)',
        'Clear (Breezy)': 'Clear (Breezy)',
        'Partly Cloudy': 'Partly Cloudy',
        'Overcast (Light)': 'Overcast (Light)',
        'Overcast (Heavy)': 'Overcast (Heavy)',
        'Mist': 'Mist',
        'Fog (Dense)': 'Fog (Dense)',
        'Drizzle': 'Drizzle',
        'Light Rain': 'Light Rain',
        'Rain': 'Rain',
        'Heavy Rain': 'Heavy Rain',
        'Thunderstorm': 'Thunderstorm',
        'Snow Flurries': 'Snow Flurries',
        'Snow': 'Snow',
        'Blizzard': 'Blizzard'
      }
    }).on('change', (ev) => {
      if (ev?.last) this.debouncedSave();
    });

    controls.transition = parentFolder.addBinding(this.controlState, 'directedTransitionMinutes', {
      label: 'Transition (min)',
      min: 0.1,
      max: 60,
      step: 0.1
    }).on('change', (ev) => {
      if (ev?.last) this.debouncedSave();
    });

    const buttonGroup = parentFolder.addButton({
      title: 'Start Transition'
    }).on('click', () => {
      void this._startDirectedTransition().then(() => this.debouncedSave());
    });

    controls.startButton = buttonGroup;

    return controls;
  }

  /**
   * Build wind controls
   * @param {Tweakpane.Folder} parentFolder
   * @returns {Object} Control references
   * @private
   */
  _buildWindControls(parentFolder, options = undefined) {
    const includeGustiness = options?.includeGustiness !== false;
    const controls = {};

    controls.speed = parentFolder.addBinding(this.controlState, 'windSpeedMS', {
      label: 'Wind Speed (m/s)',
      min: 0.0,
      max: 78.0,
      step: 0.5
    }).on('change', (ev) => {
      void this._applyWindState();
      if (ev?.last) this.debouncedSave();
    });

    controls.direction = parentFolder.addBinding(this.controlState, 'windDirection', {
      label: 'Direction (°)',
      min: 0,
      max: 360,
      step: 5
    }).on('change', (ev) => {
      void this._applyWindState();
      if (ev?.last) this.debouncedSave();
    });

    if (includeGustiness) {
      controls.gustiness = parentFolder.addBinding(this.controlState, 'gustiness', {
        label: 'Gustiness',
        options: {
          'Calm': 'calm',
          'Light': 'light',
          'Moderate': 'moderate',
          'Strong': 'strong',
          'Extreme': 'extreme'
        }
      }).on('change', (ev) => {
        void this._applyWindState();
        if (ev?.last) this.debouncedSave();
      });
    }

    return controls;
  }

  _buildWindSection(parentFolder = this.pane, options = undefined) {
    const targetFolder = parentFolder || this.pane;
    const windFolder = targetFolder.addFolder({
      title: options?.title ?? '💨 Wind',
      expanded: options?.expanded ?? false
    });
    if (options?.registerTopLevel !== false && targetFolder === this.pane) this._registerTopLevelFolder(windFolder);
    const initialWindMs = Number(this.controlState.windSpeedMS) || 0;
    const initialPct = `${Math.round(Math.max(0, Math.min(1, initialWindMs / 78.0)) * 100)}%`;
    this._ensureFolderTag(windFolder, 'wind', initialPct);

    const quickWindFolder = windFolder.addFolder({
      title: 'Quick Wind',
      expanded: true
    });

    this.windControls = this._buildWindControls(quickWindFolder, { includeGustiness: false });

    quickWindFolder.addBlade({ view: 'separator' });

    const beats = {
      Calm: { speedMS: 4.0, gustiness: 'calm' },
      Breezy: { speedMS: 14.0, gustiness: 'light' },
      Windy: { speedMS: 28.0, gustiness: 'strong' },
      Storm: { speedMS: 50.0, gustiness: 'extreme' }
    };

    const contentElement = quickWindFolder.element.querySelector('.tp-fldv_c') || quickWindFolder.element;
    const grid = document.createElement('div');
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = '1fr 1fr';
    grid.style.gap = '6px';
    grid.style.marginTop = '6px';

    for (const [label, cfg] of Object.entries(beats)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.style.padding = '6px 8px';
      btn.style.borderRadius = '6px';
      btn.style.border = '1px solid rgba(255,255,255,0.15)';
      btn.style.background = 'rgba(255,255,255,0.06)';
      btn.style.color = 'inherit';
      btn.style.cursor = 'pointer';
      btn.addEventListener('click', () => {
        this.controlState.windSpeedMS = cfg.speedMS;
        this.controlState.gustiness = cfg.gustiness;
        try {
          this.pane?.refresh?.();
        } catch (_) {
        }
        void this._applyWindState();
        this.debouncedSave();
      });
      grid.appendChild(btn);
    }
    contentElement.appendChild(grid);

    const advancedFolder = windFolder.addFolder({
      title: 'Advanced Wind',
      expanded: false
    });

    advancedFolder.addBinding(this.controlState, 'gustiness', {
      label: 'Gustiness',
      options: {
        'Calm': 'calm',
        'Light': 'light',
        'Moderate': 'moderate',
        'Strong': 'strong',
        'Extreme': 'extreme'
      }
    }).on('change', (ev) => {
      void this._applyWindState();
      if (ev?.last) this.debouncedSave();
    });
  }

  /**
   * Update visibility of weather controls based on mode
   * @private
   */
  _updateWeatherControls() {
    const isDynamic = this.controlState.weatherMode === 'dynamic';

    // Keep mode sections explicit in the hierarchy, auto-expanding the active mode
    // so the GM always lands on the relevant controls during live play.
    if (this._weatherDynamicFolder) this._weatherDynamicFolder.expanded = isDynamic;
    if (this._weatherDirectedFolder) this._weatherDirectedFolder.expanded = !isDynamic;
    this._refreshWeatherFolderTag();
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
    scopeNote.textContent = game.user?.isGM
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
        if (!playing) this._setFolderTag('tileMotion', 'Stopped');
        else if (paused) this._setFolderTag('tileMotion', `Paused ${Math.round(clamped)}%`);
        else this._setFolderTag('tileMotion', `${Math.round(clamped)}%`);
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
        this._tileMotionSpeedBinding?.refresh?.();
        this._tileMotionAutoPlayBinding?.refresh?.();
        this._tileMotionTimeFactorBinding?.refresh?.();
        this._tileMotionPausedBinding?.refresh?.();
      } catch (_) {
      }
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
    if (!game.user?.isGM) {
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
    if (!game.user?.isGM) {
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
    if (!game.user?.isGM) {
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
    if (!game.user?.isGM) {
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
    if (!game.user?.isGM) {
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

  _buildTileMotionSection(parentFolder = this.pane, options = undefined) {
    const targetFolder = parentFolder || this.pane;
    const tileMotionFolder = targetFolder.addFolder({
      title: options?.title ?? '🧭 Tile Motion',
      expanded: options?.expanded ?? false
    });
    if (options?.registerTopLevel !== false && targetFolder === this.pane) this._registerTopLevelFolder(tileMotionFolder);
    this._ensureFolderTag(tileMotionFolder, 'tileMotion', `${Math.round(Number(this.controlState.tileMotionSpeedPercent) || 0)}%`);

    const canEditTileMotion = game.user?.isGM === true && !!window.MapShine?.tileMotionManager;
    if (!canEditTileMotion) {
      const content = tileMotionFolder.element.querySelector('.tp-fldv_c') || tileMotionFolder.element;
      const reason = document.createElement('div');
      reason.textContent = game.user?.isGM
        ? 'Unavailable: Tile motion manager is not ready yet.'
        : 'Unavailable: Tile motion controls are GM-only.';
      reason.style.fontSize = '11px';
      reason.style.opacity = '0.78';
      reason.style.margin = '4px 0 8px';
      content.appendChild(reason);
    }

    this._tileMotionAutoPlayBinding = tileMotionFolder.addBinding(this.controlState, 'tileMotionAutoPlayEnabled', {
      label: 'Auto'
    }).on('change', (ev) => {
      this.controlState.tileMotionAutoPlayEnabled = !!ev.value;
      void this._setTileMotionAutoPlayEnabled(!!ev.value, { persist: !!ev?.last });
      if (ev?.last) this.debouncedSave();
    });
    this._tileMotionAutoPlayBinding.disabled = !canEditTileMotion;

    this._tileMotionPausedBinding = tileMotionFolder.addBinding(this.controlState, 'tileMotionPaused', {
      label: 'Paused'
    }).on('change', (ev) => {
      this.controlState.tileMotionPaused = !!ev.value;
      void this._setTileMotionPaused(!!ev.value, { persist: !!ev?.last });
      if (ev?.last) this.debouncedSave();
    });
    this._tileMotionPausedBinding.disabled = !canEditTileMotion;

    this._tileMotionTimeFactorBinding = tileMotionFolder.addBinding(this.controlState, 'tileMotionTimeFactorPercent', {
      label: 'Time %',
      min: 0,
      max: 200,
      step: 1
    }).on('change', (ev) => {
      this.controlState.tileMotionTimeFactorPercent = ev.value;
      void this._setTileMotionTimeFactor(ev.value, { persist: !!ev?.last });
      if (ev?.last) this.debouncedSave();
    });
    this._tileMotionTimeFactorBinding.disabled = !canEditTileMotion;

    this._tileMotionSpeedBinding = tileMotionFolder.addBinding(this.controlState, 'tileMotionSpeedPercent', {
      label: 'Speed %',
      min: 0,
      max: 400,
      step: 1
    }).on('change', (ev) => {
      this.controlState.tileMotionSpeedPercent = ev.value;
      this._setFolderTag('tileMotion', `${Math.round(Number(ev.value) || 0)}%`);
      void this._setTileMotionSpeed(ev.value, { persist: !!ev?.last });
      if (ev?.last) this.debouncedSave();
    });
    this._tileMotionSpeedBinding.disabled = !canEditTileMotion;

    const contentElement = tileMotionFolder.element.querySelector('.tp-fldv_c') || tileMotionFolder.element;
    const transportGrid = document.createElement('div');
    transportGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:4px 6px 6px;';

    const makeTransportBtn = (label, onClick) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.disabled = !canEditTileMotion;
      btn.style.cssText = [
        'height:20px',
        'padding:0 6px',
        'border-radius:5px',
        'border:1px solid rgba(255,255,255,0.12)',
        'background:rgba(255,255,255,0.06)',
        'color:rgba(210,232,255,0.90)',
        'font-size:9px',
        'font-weight:600',
        'font-family:inherit',
        'cursor:pointer'
      ].join(';');
      btn.addEventListener('click', onClick);
      transportGrid.appendChild(btn);
    };

    makeTransportBtn('Start', () => { void this._startTileMotion(); });
    makeTransportBtn('Pause', () => { void this._pauseTileMotion(); });
    makeTransportBtn('Resume', () => { void this._resumeTileMotion(); });
    makeTransportBtn('Stop', () => { void this._stopTileMotion(); });
    makeTransportBtn('Reset', () => { void this._resetTileMotionPhase(); });

    const spacer = document.createElement('div');
    spacer.style.display = 'none';
    transportGrid.appendChild(spacer);

    contentElement.appendChild(transportGrid);
  }

  /**
   * Apply control state to game systems using centralized StateApplier
   * @private
   */
  async _applyControlState() {
    try {
      const targetHour = ((Number(this.controlState.timeOfDay) % 24) + 24) % 24;
      const transitionMinutes = Number(this.controlState.timeTransitionMinutes) || 0;
      const shouldStartTransition =
        transitionMinutes > 0 &&
        (this._lastTimeTargetApplied === null ||
          Math.abs(this._lastTimeTargetApplied - targetHour) > 1e-4 ||
          this._lastTimeTransitionMinutesApplied === null ||
          Math.abs(this._lastTimeTransitionMinutesApplied - transitionMinutes) > 1e-4);

      const shouldApplyInstant =
        transitionMinutes <= 0 &&
        (this._lastTimeTargetApplied === null || Math.abs(this._lastTimeTargetApplied - targetHour) > 1e-4);

      if (shouldStartTransition) {
        this._lastTimeTargetApplied = targetHour;
        this._lastTimeTransitionMinutesApplied = transitionMinutes;
        await stateApplier.startTimeOfDayTransition(targetHour, transitionMinutes, false, false);
      } else if (shouldApplyInstant) {
        this._lastTimeTargetApplied = targetHour;
        this._lastTimeTransitionMinutesApplied = transitionMinutes;
        // Do not call Foundry scene darkness from live slider — sync once on debouncedSave.
        await stateApplier.applyTimeOfDay(targetHour, false, false);
      }

      if (this._suppressInitialWeatherApply) {
        this._suppressInitialWeatherApply = false;
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
      const weatherController = coreWeatherController || window.MapShine?.weatherController || window.weatherController;
      if (!weatherController) {
        log.warn('WeatherController not available for wind application');
        return;
      }

      const resolvedWindDir = (typeof weatherController._windDirFromAngleDeg === 'function')
        ? weatherController._windDirFromAngleDeg(this.controlState.windDirection)
        : (() => {
            const directionRad = (this.controlState.windDirection * Math.PI) / 180.0;
            // Foundry-space direction is Y-down.
            return { x: Math.cos(directionRad), y: -Math.sin(directionRad) };
          })();
      const dirX = Number.isFinite(resolvedWindDir?.x) ? resolvedWindDir.x : 1.0;
      const dirY = Number.isFinite(resolvedWindDir?.y) ? resolvedWindDir.y : 0.0;

      // WeatherController.update() derives currentState from targetState every frame.
      // So, to make the override "stick", we must write to targetState.
      // Also: windDirection is expected to be a THREE.Vector2 after initialize(); never replace it.
      const applyToState = (state) => {
        if (!state) return;
        const windMS = Number(this.controlState.windSpeedMS);
        const clampedMS = Number.isFinite(windMS) ? Math.max(0.0, Math.min(78.0, windMS)) : 0.0;
        state.windSpeedMS = clampedMS;
        state.windSpeed = clampedMS / 78.0;

        const wd = state.windDirection;
        if (wd && typeof wd.set === 'function') {
          wd.set(dirX, dirY);
          if (typeof wd.normalize === 'function') wd.normalize();
        } else {
          // Fallback for early init / unexpected shapes
          state.windDirection = { x: dirX, y: dirY };
        }
      };

      applyToState(weatherController.targetState);

      // Mirror to currentState so the change is visible immediately this frame
      // (even before the next WeatherController.update()).
      applyToState(weatherController.currentState);

      // Legacy gustiness controls are intentionally no longer written here.
      // Wind variability is generated continuously from current wind speed.

      log.debug('Applied wind state:', {
        speedMS: this.controlState.windSpeedMS,
        direction: this.controlState.windDirection,
        gustiness: this.controlState.gustiness
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
      tileMotionPaused: false
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
    
    // Refresh bindings
    if (this.pane) {
      this.pane.refresh();
    }
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
      if (!scene || !game.user?.isGM) return;

      extendMsaLocalFlagWriteGuard();
      await scene.setFlag('map-shine-advanced', 'controlState', this.controlState);
      // One Foundry darkness write after persist — avoids hammering canvas.scene.update
      // on every clock tick / 100ms transition frame (can grey-break V2 rendering).
      await stateApplier.syncFoundryDarknessFromMapShineTime();
      log.debug('Saved control state to scene flags');
    } catch (error) {
      log.warn('Failed to save control state:', error);
    }
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
      const left = this._readPx(this._minimizedButton?.style?.left);
      const top = this._readPx(this._minimizedButton?.style?.top);
      if (Number.isFinite(left) && Number.isFinite(top)) {
        this.container.style.transform = 'none';
        this.container.style.left = `${left}px`;
        this.container.style.top = `${top}px`;
      }
      this._hideMinimizedButton();
      this._isMinimized = false;
    }
    
    this.container.style.display = 'block';
    this.visible = true;
    
    // Update clock to current state
    this._updateClock(this.controlState.timeOfDay);

    this._wireLiveWeatherOverrideBindingsIfReady();
    try {
      hydrateControlPanelLiveOverridesFromController(resolveWeatherController());
    } catch (_) {}

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
    
    this.container.style.display = 'none';
    this.visible = false;
    this._isMinimized = false;
    this._hideMinimizedButton();

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
    document.removeEventListener('mousemove', this._boundHandlers.onDocMouseMove, { capture: true });
    document.removeEventListener('mouseup', this._boundHandlers.onDocMouseUp, { capture: true });
    document.removeEventListener('touchmove', this._boundHandlers.onDocTouchMove);
    document.removeEventListener('touchend', this._boundHandlers.onDocTouchEnd);

    document.removeEventListener('mousemove', this._boundHandlers.onDocPanelMouseMove, { capture: true });
    document.removeEventListener('mouseup', this._boundHandlers.onDocPanelMouseUp, { capture: true });

    if (this.headerOverlay) {
      this.headerOverlay.removeEventListener('mousedown', this._boundHandlers.onHeaderMouseDown);
    }

    if (this._minimizeButton) {
      this._minimizeButton.removeEventListener('click', this._boundHandlers.onMinimizeButtonClick);
    }

    if (this._minimizedButton) {
      this._minimizedButton.removeEventListener('click', this._boundHandlers.onMinimizedBadgeClick);
      if (this._minimizedButton.parentNode) {
        this._minimizedButton.parentNode.removeChild(this._minimizedButton);
      }
    }

    // Destroy Tweakpane
    if (this.pane) {
      this.pane.dispose();
    }

    // Remove container
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }

    // Clear references
    this.pane = null;
    this.container = null;
    this.clockElement = null;
    this.clockElements = {};
    this.statusPanel = null;
    this._statusEls = null;
    this.headerOverlay = null;
    this._minimizeButton = null;
    this._minimizedButton = null;
    this._isMinimized = false;
    this._sunLatitudeBinding = null;
    this._tileMotionSpeedBinding = null;

    this._liveWeatherOverrideDomBuilt = false;
    this._rapidWeatherBindingTarget = null;
    this._liveWeatherOverrideFolder = null;
    this._liveWeatherOverrideDom = null;

    log.info('Control panel destroyed');
  }
}
