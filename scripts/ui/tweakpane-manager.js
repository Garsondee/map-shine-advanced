/**
 * @fileoverview Tweakpane UI Manager for Map Shine Advanced
 * Manages the parameter control panel with performance optimizations
 * @module ui/tweakpane-manager
 */

import { createLogger } from '../core/log.js';
import { stateApplier } from './state-applier.js';
import { globalValidator, getSpecularEffectiveState, getStripeDependencyState } from './parameter-validator.js';
import { TextureManagerUI } from './texture-manager.js';
import { EffectStackUI } from './effect-stack.js';
import { DiagnosticCenterManager } from './diagnostic-center.js';
import { OVERLAY_THREE_LAYER, TILE_FEATURE_LAYERS } from '../effects/EffectComposer.js';
import * as sceneSettings from '../settings/scene-settings.js';
import Coordinates from '../utils/coordinates.js';
import { debugLoadingProfiler } from '../core/debug-loading-profiler.js';

const log = createLogger('UI');

/**
 * Manages the Tweakpane UI panel with state persistence and performance optimizations
 * Implements decoupled UI loop, throttling, and client settings persistence
 */
export class TweakpaneManager {
  constructor() {
    /** @type {Tweakpane.Pane|null} */
    this.pane = null;
    
    /** @type {HTMLElement|null} */
    this.container = null;
    
    /** @type {Object<string, any>} Effect folders */
    this.effectFolders = {};
    
    /** @type {Set<string>} Parameters that need updating */
    this.dirtyParams = new Set();
    
    /** @type {Map<string, Function>} Registered effect update callbacks */
    this.effectCallbacks = new Map();
    
    /** @type {number} UI update loop frame rate */
    this.uiFrameRate = 15; // Hz
    
    /** @type {number} Last UI frame timestamp */
    this.lastUIFrame = 0;
    
    /** @type {boolean} Whether UI loop is running */
    this.running = false;
    
    /** @type {boolean} Whether panel is visible */
    this.visible = false;
    
    /** @type {number|null} RAF handle for UI loop */
    this.rafHandle = null;
    
    /** @type {Object} Performance metrics */
    this.perf = {
      lastFrameTime: 0,
      avgFrameTime: 0,
      frameCount: 0,
      warningCount: 0
    };
    
    /** @type {Object} Global parameters */
    this.globalParams = {
      mapMakerMode: false,
      timeRate: 100, // 0-200%
      sunLatitude: 0.1, // 0=flat east/west, 1=maximum north/south arc (single source of truth for all effects)
      // Light authoring UI visibility toggles
      showLightTranslateGizmo: true,
      showLightRadiusRings: true,
      showLightRadiusVisualization: true,
      tokenColorCorrection: {
        enabled: true,
        exposure: 1.0,
        temperature: 0.0,
        tint: 0.0,
        brightness: 0.0,
        contrast: 1.0,
        saturation: 1.0,
        gamma: 1.0,
        windowLightIntensity: 1.0
      },
      dynamicExposure: {
        enabled: true,
        minExposure: 0.5,
        maxExposure: 2.5,
        probeHz: 8,
        tauBrighten: 15.0,
        tauDarken: 15.0
      },
      dynamicExposureDebug: {
        subjectTokenId: '',
        measuredLuma: 0.0,
        outdoors: 0.0,
        targetExposure: 1.0,
        appliedExposure: 1.0,
        screenU: 0.0,
        screenV: 0.0,
        lastProbeAgeSeconds: 0.0
      }
    };
    
    /** @type {Object<string, any>} Accordion expanded states */
    this.accordionStates = {};
    
    /** @type {string} Current settings mode: 'mapMaker' or 'gm' */
    this.settingsMode = 'mapMaker';
    
    /** @type {Object<string, any>} Category folders */
    this.categoryFolders = {};

    /** @type {Set<string>} Effects queued for save */
    this.saveQueue = new Set();
    
    /** @type {number} Last save timestamp */
    this.lastSave = 0;
    
    /** @type {number} Save debounce time (ms) */
    this.saveDebounceMs = 1000;

    /** @type {HTMLElement|null} Custom header overlay used for dragging and controls */
    this.headerOverlay = null;

    /** @type {TextureManagerUI|null} */
    this.textureManager = null;

    /** @type {EffectStackUI|null} */
    this.effectStack = null;

    /** @type {DiagnosticCenterManager|null} */
    this.diagnosticCenter = null;

    /** @type {number} UI scale factor */
    this.uiScale = 1.0;

    /** @type {{scale:number}} Backing object for UI scale binding */
    this.uiScaleParams = { scale: this.uiScale };

    this.ropeDefaults = {
      ropeTexturePath: 'modules/map-shine-advanced/assets/rope.webp',
      chainTexturePath: 'modules/map-shine-advanced/assets/rope.webp'
    };

    this.ropeBehaviorDefaults = {
      rope: {
        segmentLength: 12,
        damping: 0.98,
        windForce: 1.2,
        bendStiffness: 0.5,
        tapering: 0.55,
        width: 22,
        uvRepeatWorld: 64,
        windowLightBoost: 10.0,
        endFadeSize: 0.0,
        endFadeStrength: 0.0,
        gravityStrength: 1.0,
        slackFactor: 1.05,
        windGustAmount: 0.5,
        invertWindDirection: false,
        constraintIterations: 6
      },
      chain: {
        segmentLength: 22,
        damping: 0.92,
        windForce: 0.25,
        bendStiffness: 0.5,
        tapering: 0.15,
        width: 18,
        uvRepeatWorld: 48,
        windowLightBoost: 10.0,
        endFadeSize: 0.0,
        endFadeStrength: 0.0,
        gravityStrength: 1.0,
        slackFactor: 1.02,
        windGustAmount: 0.5,
        invertWindDirection: false,
        constraintIterations: 6
      }
    };

    this._ropesFolder = null;

    /** @type {number|null} Pending UI state save timeout */
    this._uiStateSaveTimeout = null;

    /** @type {Object|null} Snapshot for master reset undo */
    this.lastMasterResetSnapshot = null;

    /** @type {any|null} Tweakpane button for Undo */
    this.undoButton = null;

    this._uiValidatorActive = false;
    this._uiValidatorRunning = false;
    this._uiValidatorButton = null;
    this._uiValidatorGlobalHandlers = {};

    this._debugFolder = null;

    /** @type {Array<any>|null} */
    this._dynamicExposureDebugBindings = null;
  }

  _getProperty(obj, path) {
    if (!obj || typeof obj !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, path)) return obj[path];

    const utils = globalThis.foundry?.utils;
    if (utils?.getProperty) {
      try {
        return utils.getProperty(obj, path);
      } catch (e) {
      }
    }

    const parts = String(path).split('.');
    let cur = obj;
    for (const p of parts) {
      if (!cur || typeof cur !== 'object') return undefined;
      cur = cur[p];
    }
    return cur;
  }

  _setProperty(obj, path, value) {
    const utils = globalThis.foundry?.utils;
    if (utils?.setProperty) {
      try {
        utils.setProperty(obj, path, value);
        return;
      } catch (e) {
      }
    }

    const parts = String(path).split('.');
    let cur = obj;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (i === parts.length - 1) {
        cur[p] = value;
      } else {
        if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
        cur = cur[p];
      }
    }
  }

  _deepMergeObjects(base, override) {
    const out = (base && typeof base === 'object')
      ? (Array.isArray(base) ? base.slice() : { ...base })
      : {};

    if (!override || typeof override !== 'object') return out;

    for (const [k, v] of Object.entries(override)) {
      // Undefined values are not persisted in Foundry flags; omit to keep merge stable.
      if (v === undefined) continue;

      if (v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = this._deepMergeObjects(out[k], v);
      } else {
        out[k] = v;
      }
    }

    return out;
  }

  /**
   * Initialize the UI panel
   * @param {HTMLElement} [parentElement] - Optional parent element (defaults to body)
   * @returns {Promise<void>}
   */
  async initialize(parentElement = document.body) {
    if (this.pane) {
      try {
        this.buildRopesSection();
      } catch (e) {
      }
      log.warn('TweakpaneManager already initialized');
      return;
    }

    const _dlp = debugLoadingProfiler;
    const _isDbg = _dlp.debugMode;

    // Wait for Tweakpane to be available (up to 5 seconds)
    if (_isDbg) _dlp.begin('tp.waitForLib', 'finalize');
    log.info('Waiting for Tweakpane library to load...');
    const startTime = Date.now();
    while (typeof Tweakpane === 'undefined' && (Date.now() - startTime) < 5000) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (_isDbg) _dlp.end('tp.waitForLib');

    if (typeof Tweakpane === 'undefined') {
      log.error('Tweakpane library failed to load after 5 seconds');
      throw new Error('Tweakpane library not available');
    }

    log.info('Initializing Tweakpane UI...');

    // Create container
    this.container = document.createElement('div');
    this.container.id = 'map-shine-ui';
    this.container.style.position = 'fixed';
    this.container.style.zIndex = '10000'; // Above Foundry UI
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
      title: 'Map Shine Advanced',
      container: this.container,
      expanded: true
    });

    // Create a custom transparent header overlay for dragging and controls
    this.headerOverlay = document.createElement('div');
    this.headerOverlay.className = 'map-shine-ui-header-overlay';
    this.headerOverlay.style.position = 'absolute';
    this.headerOverlay.style.top = '0';
    this.headerOverlay.style.left = '0';
    this.headerOverlay.style.right = '0';
    this.headerOverlay.style.height = '24px';
    this.headerOverlay.style.pointerEvents = 'auto';
    this.headerOverlay.style.cursor = 'move';
    this.headerOverlay.style.background = 'transparent';
    this.headerOverlay.style.zIndex = '10001';
    this.container.style.position = 'fixed';
    this.container.appendChild(this.headerOverlay);

    // Add custom title bar controls (e.g., minimize button)
    this.addTitleControls();

    // Load saved UI state (position, scale, accordion states)
    if (_isDbg) _dlp.begin('tp.loadUIState', 'finalize');
    await this.loadUIState();
    if (_isDbg) _dlp.end('tp.loadUIState');

    if (_isDbg) _dlp.begin('tp.buildSections', 'finalize');
    this.buildBrandingSection();

    // Build scene setup section (only for GMs)
    if (game.user.isGM) {
      this.buildSceneSetupSection();
    }

    // Build global controls
    this.buildGlobalControls();

    // Build environment section (sun latitude etc.) — single source of truth
    this.buildEnvironmentSection();

    this.buildRopesSection();

    this.buildDebugSection();
    if (_isDbg) _dlp.end('tp.buildSections');

    // Start UI update loop
    this.startUILoop();

    // Make pane draggable
    this.makeDraggable();

    // Initialize Texture Manager
    if (_isDbg) _dlp.begin('tp.textureManager.init', 'finalize');
    this.textureManager = new TextureManagerUI();
    await this.textureManager.initialize();
    if (_isDbg) _dlp.end('tp.textureManager.init');

    // Initialize Effect Stack
    if (_isDbg) _dlp.begin('tp.effectStack.init', 'finalize');
    this.effectStack = new EffectStackUI();
    await this.effectStack.initialize();
    if (_isDbg) _dlp.end('tp.effectStack.init');

    // Initialize Diagnostic Center
    if (_isDbg) _dlp.begin('tp.diagnosticCenter.init', 'finalize');
    this.diagnosticCenter = new DiagnosticCenterManager();
    await this.diagnosticCenter.initialize();
    if (_isDbg) _dlp.end('tp.diagnosticCenter.init');

    // Start hidden by default for release; can be opened via the scene control button.
    this.hide();

    log.info('Tweakpane UI initialized');
  }

  /**
   * Add custom controls to the Tweakpane title bar (e.g., minimize button)
   * @private
   */
  addTitleControls() {
    if (!this.container) return;

    // Prefer custom header overlay; fall back to pane root if needed
    const header = this.headerOverlay || this.pane?.element || this.container;

    // Create a small [-] button on the left side of the title bar
    const button = document.createElement('button');
    button.textContent = '\u2212'; // minus sign
    button.title = 'Minimize / Restore Map Shine panel';
    button.style.position = 'absolute';
    button.style.left = '8px';
    button.style.top = '4px';
    button.style.padding = '0 6px';
    button.style.border = 'none';
    button.style.background = 'transparent';
    button.style.color = 'inherit';
    button.style.cursor = 'pointer';
    button.style.fontSize = '12px';

    // Prevent this button from starting a drag operation on mousedown
    button.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    // Toggle pane expanded state on click
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.pane) {
        this.pane.expanded = !this.pane.expanded;
      }
    });

    header.appendChild(button);
    log.debug('Title controls added to Tweakpane header');
  }

  /**
   * Build global control section
   * @private
   */
  buildGlobalControls() {
    const globalFolder = this.pane.addFolder({
      title: 'Global Controls',
      expanded: this.accordionStates['global'] ?? true
    });

    // Map Maker Mode toggle
    const onMapMakerModeChange = (ev) => {
      this.onGlobalChange('mapMakerMode', ev.value);
    };
    this._uiValidatorGlobalHandlers.mapMakerMode = onMapMakerModeChange;

    globalFolder.addBinding(this.globalParams, 'mapMakerMode', {
      label: 'Map Maker Mode'
    }).on('change', onMapMakerModeChange);

    // Time rate slider
    const onTimeRateChange = (ev) => {
      this.onGlobalChange('timeRate', ev.value);
    };
    this._uiValidatorGlobalHandlers.timeRate = onTimeRateChange;

    globalFolder.addBinding(this.globalParams, 'timeRate', {
      label: 'Time Rate',
      min: 0,
      max: 200,
      step: 1
    }).on('change', onTimeRateChange);

    // Visual separator between time controls and UI/tools controls
    globalFolder.addBlade({ view: 'separator' });

    // UI Scale
    const onUiScaleChange = (ev) => {
      this.uiScale = ev.value;
      this.uiScaleParams.scale = ev.value;
      if (ev.last) {
        setTimeout(() => {
          this.updateScale();
          this.saveUIState();
        }, 100);
      }
    };
    this._uiValidatorGlobalHandlers.uiScale = onUiScaleChange;

    globalFolder.addBinding(this.uiScaleParams, 'scale', {
      label: 'UI Scale',
      min: 0.5,
      max: 2.0,
      step: 0.1
    }).on('change', onUiScaleChange);

    // Light Authoring UI visibility folder
    const lightAuthoringFolder = globalFolder.addFolder({
      title: 'Light Authoring UI',
      expanded: this.accordionStates['lightAuthoring'] ?? false
    });

    const onLightUIToggle = (param) => (ev) => {
      this.globalParams[param] = ev.value;
      this.onGlobalChange(param, ev.value);
      this.saveUIState();
    };

    lightAuthoringFolder.addBinding(this.globalParams, 'showLightTranslateGizmo', {
      label: 'Translate Gizmo'
    }).on('change', onLightUIToggle('showLightTranslateGizmo'));

    lightAuthoringFolder.addBinding(this.globalParams, 'showLightRadiusRings', {
      label: 'Radius Edit Rings'
    }).on('change', onLightUIToggle('showLightRadiusRings'));

    lightAuthoringFolder.addBinding(this.globalParams, 'showLightRadiusVisualization', {
      label: 'Radius Visualization'
    }).on('change', onLightUIToggle('showLightRadiusVisualization'));

    lightAuthoringFolder.on('fold', (ev) => {
      this.accordionStates['lightAuthoring'] = ev.expanded;
      this.saveUIState();
    });

    globalFolder.addBlade({ view: 'separator' });

    const tokensFolder = globalFolder.addFolder({
      title: 'Tokens',
      expanded: this.accordionStates['tokens'] ?? false
    });

    const tokenCCFolder = tokensFolder.addFolder({
      title: 'Color Correction',
      expanded: this.accordionStates['token_cc'] ?? false
    });

    const applyTokenCC = () => {
      try {
        const tm = window.MapShine?.tokenManager;
        if (tm && typeof tm.setColorCorrectionParams === 'function') {
          tm.setColorCorrectionParams(this.globalParams.tokenColorCorrection);
        }
      } catch (_) {
      }
    };

    const onTokenCCChange = (param) => (ev) => {
      this.globalParams.tokenColorCorrection[param] = ev.value;
      applyTokenCC();
      this.saveUIState();
    };

    tokenCCFolder.addBinding(this.globalParams.tokenColorCorrection, 'enabled', {
      label: 'Enabled'
    }).on('change', onTokenCCChange('enabled'));

    tokenCCFolder.addBinding(this.globalParams.tokenColorCorrection, 'exposure', {
      label: 'Exposure',
      min: 0,
      max: 3,
      step: 0.01
    }).on('change', onTokenCCChange('exposure'));

    tokenCCFolder.addBinding(this.globalParams.tokenColorCorrection, 'brightness', {
      label: 'Brightness',
      min: -0.5,
      max: 0.5,
      step: 0.01
    }).on('change', onTokenCCChange('brightness'));

    tokenCCFolder.addBinding(this.globalParams.tokenColorCorrection, 'contrast', {
      label: 'Contrast',
      min: 0,
      max: 2,
      step: 0.01
    }).on('change', onTokenCCChange('contrast'));

    tokenCCFolder.addBinding(this.globalParams.tokenColorCorrection, 'saturation', {
      label: 'Saturation',
      min: 0,
      max: 2,
      step: 0.01
    }).on('change', onTokenCCChange('saturation'));

    tokenCCFolder.addBinding(this.globalParams.tokenColorCorrection, 'gamma', {
      label: 'Gamma',
      min: 0.2,
      max: 3,
      step: 0.01
    }).on('change', onTokenCCChange('gamma'));

    tokenCCFolder.addBinding(this.globalParams.tokenColorCorrection, 'temperature', {
      label: 'Temperature',
      min: -1,
      max: 1,
      step: 0.01
    }).on('change', onTokenCCChange('temperature'));

    tokenCCFolder.addBinding(this.globalParams.tokenColorCorrection, 'tint', {
      label: 'Tint',
      min: -1,
      max: 1,
      step: 0.01
    }).on('change', onTokenCCChange('tint'));

    tokenCCFolder.addBinding(this.globalParams.tokenColorCorrection, 'windowLightIntensity', {
      label: 'Window Light Intensity',
      min: 0,
      max: 2,
      step: 0.01
    }).on('change', onTokenCCChange('windowLightIntensity'));

    tokenCCFolder.addButton({
      title: 'Reset Token CC'
    }).on('click', () => {
      this.globalParams.tokenColorCorrection.enabled = true;
      this.globalParams.tokenColorCorrection.exposure = 1.0;
      this.globalParams.tokenColorCorrection.temperature = 0.0;
      this.globalParams.tokenColorCorrection.tint = 0.0;
      this.globalParams.tokenColorCorrection.brightness = 0.0;
      this.globalParams.tokenColorCorrection.contrast = 1.0;
      this.globalParams.tokenColorCorrection.saturation = 1.0;
      this.globalParams.tokenColorCorrection.gamma = 1.0;
      this.globalParams.tokenColorCorrection.windowLightIntensity = 1.0;

      // Refresh bindings under this folder.
      try {
        tokenCCFolder.refresh();
      } catch (_) {
      }

      applyTokenCC();
      this.saveUIState();
    });

    tokenCCFolder.on('fold', (ev) => {
      this.accordionStates['token_cc'] = ev.expanded;
      this.saveUIState();
    });

    const dynamicExposureFolder = tokensFolder.addFolder({
      title: 'Dynamic Exposure',
      expanded: this.accordionStates['token_dynamicExposure'] ?? false
    });

    const applyDynamicExposure = () => {
      try {
        const dem = window.MapShine?.dynamicExposureManager;
        if (dem && typeof dem.setParams === 'function') {
          dem.setParams(this.globalParams.dynamicExposure);
        }
      } catch (_) {
      }
    };

    const onDynamicExposureChange = (param) => (ev) => {
      this.globalParams.dynamicExposure[param] = ev.value;
      applyDynamicExposure();
      this.saveUIState();
    };

    dynamicExposureFolder.addBinding(this.globalParams.dynamicExposure, 'enabled', {
      label: 'Enabled'
    }).on('change', onDynamicExposureChange('enabled'));

    dynamicExposureFolder.addBinding(this.globalParams.dynamicExposure, 'minExposure', {
      label: 'Min Exposure',
      min: 0.1,
      max: 4,
      step: 0.01
    }).on('change', onDynamicExposureChange('minExposure'));

    dynamicExposureFolder.addBinding(this.globalParams.dynamicExposure, 'maxExposure', {
      label: 'Max Exposure',
      min: 0.1,
      max: 8,
      step: 0.01
    }).on('change', onDynamicExposureChange('maxExposure'));

    dynamicExposureFolder.addBinding(this.globalParams.dynamicExposure, 'probeHz', {
      label: 'Probe Hz',
      min: 0.5,
      max: 30,
      step: 0.5
    }).on('change', onDynamicExposureChange('probeHz'));

    dynamicExposureFolder.addBinding(this.globalParams.dynamicExposure, 'tauBrighten', {
      label: 'Decay Up (s)',
      min: 0.05,
      max: 30,
      step: 0.01
    }).on('change', onDynamicExposureChange('tauBrighten'));

    dynamicExposureFolder.addBinding(this.globalParams.dynamicExposure, 'tauDarken', {
      label: 'Decay Down (s)',
      min: 0.05,
      max: 30,
      step: 0.01
    }).on('change', onDynamicExposureChange('tauDarken'));

    const dynamicExposureDebugFolder = dynamicExposureFolder.addFolder({
      title: 'Debug (Selected Token)',
      expanded: this.accordionStates['token_dynamicExposure_debug'] ?? false
    });

    // These bindings are updated by the UI loop (see startUILoop patch below).
    this._dynamicExposureDebugBindings = [];

    this._dynamicExposureDebugBindings.push(dynamicExposureDebugFolder.addBinding(this.globalParams.dynamicExposureDebug, 'subjectTokenId', {
      label: 'Subject',
      readonly: true
    }));
    this._dynamicExposureDebugBindings.push(dynamicExposureDebugFolder.addBinding(this.globalParams.dynamicExposureDebug, 'measuredLuma', {
      label: 'Luma',
      readonly: true
    }));
    this._dynamicExposureDebugBindings.push(dynamicExposureDebugFolder.addBinding(this.globalParams.dynamicExposureDebug, 'outdoors', {
      label: 'Outdoors',
      readonly: true
    }));
    this._dynamicExposureDebugBindings.push(dynamicExposureDebugFolder.addBinding(this.globalParams.dynamicExposureDebug, 'targetExposure', {
      label: 'Target',
      readonly: true
    }));
    this._dynamicExposureDebugBindings.push(dynamicExposureDebugFolder.addBinding(this.globalParams.dynamicExposureDebug, 'appliedExposure', {
      label: 'Applied',
      readonly: true
    }));

    this._dynamicExposureDebugBindings.push(dynamicExposureDebugFolder.addBinding(this.globalParams.dynamicExposureDebug, 'screenU', {
      label: 'U',
      readonly: true
    }));
    this._dynamicExposureDebugBindings.push(dynamicExposureDebugFolder.addBinding(this.globalParams.dynamicExposureDebug, 'screenV', {
      label: 'V',
      readonly: true
    }));

    this._dynamicExposureDebugBindings.push(dynamicExposureDebugFolder.addBinding(this.globalParams.dynamicExposureDebug, 'lastProbeAgeSeconds', {
      label: 'Probe Age (s)',
      readonly: true
    }));

    dynamicExposureDebugFolder.on('fold', (ev) => {
      this.accordionStates['token_dynamicExposure_debug'] = ev.expanded;
      this.saveUIState();
    });

    dynamicExposureFolder.addButton({
      title: 'Reset Dynamic Exposure'
    }).on('click', () => {
      this.globalParams.dynamicExposure.enabled = true;
      this.globalParams.dynamicExposure.minExposure = 0.5;
      this.globalParams.dynamicExposure.maxExposure = 2.5;
      this.globalParams.dynamicExposure.probeHz = 8;
      this.globalParams.dynamicExposure.tauBrighten = 15.0;
      this.globalParams.dynamicExposure.tauDarken = 15.0;

      try {
        dynamicExposureFolder.refresh();
      } catch (_) {
      }

      applyDynamicExposure();
      this.saveUIState();
    });

    dynamicExposureFolder.on('fold', (ev) => {
      this.accordionStates['token_dynamicExposure'] = ev.expanded;
      this.saveUIState();
    });

    tokensFolder.on('fold', (ev) => {
      this.accordionStates['tokens'] = ev.expanded;
      this.saveUIState();
    });

    // Push initial state into TokenManager so the UI and runtime match.
    applyTokenCC();

    // Push initial state into DynamicExposureManager (if available).
    applyDynamicExposure();

    globalFolder.addBlade({ view: 'separator' });

    // Texture Manager Button
    globalFolder.addButton({
      title: 'Open Texture Manager',
      label: 'Tools'
    }).on('click', () => {
      if (this.textureManager) {
        this.textureManager.toggle();
      }
    });

    globalFolder.addButton({
      title: 'Open Effect Stack',
      label: 'Tools'
    }).on('click', () => {
      if (this.effectStack) {
        this.effectStack.toggle();
      }
    });

    globalFolder.addButton({
      title: 'Open Diagnostic Center',
      label: 'Tools'
    }).on('click', () => {
      if (this.diagnosticCenter) {
        this.diagnosticCenter.toggle();
      }
    });

    // Map Points Manager Button (opens management dialog with draw/edit/delete)
    globalFolder.addButton({
      title: '🎯 Manage Map Points',
      label: 'Map Points'
    }).on('click', () => {
      this.openMapPointsManagerDialog();
    });

    globalFolder.addButton({
      title: 'Scene Reset (Rebuild)',
      label: 'Tools'
    }).on('click', async () => {
      try {
        const fn = window.MapShine?.resetScene;
        if (typeof fn !== 'function') {
          ui.notifications.warn('Map Shine: Scene reset not available');
          return;
        }
        await fn();
      } catch (e) {
        try {
          ui.notifications.error('Map Shine: Scene reset failed (see console)');
        } catch (_) {
        }
        try {
          console.error('[MapShine] Scene reset failed', e);
        } catch (_) {
        }
      }
    });

    const masterResetButton = globalFolder.addButton({
      title: 'Master Reset to Defaults',
      label: 'Defaults'
    });

    masterResetButton.on('click', () => {
      this.onMasterResetToDefaults();
    });

    this.undoButton = globalFolder.addButton({
      title: 'Undo Last Master Reset',
      label: 'Undo'
    });

    this.undoButton.on('click', () => {
      this.onUndoMasterReset();
    });

    this.updateUndoButtonState();

    // Track accordion state
    globalFolder.on('fold', (ev) => {
      this.accordionStates['global'] = ev.expanded;
      this.saveUIState();
    });
  }

  /**
   * Build the Environment section — contains global sun/sky parameters that are
   * the single source of truth for all effects (shadows, window light, trees, etc.).
   * @private
   */
  buildEnvironmentSection() {
    if (!this.pane) return;

    const envFolder = this.ensureCategoryFolder('environment', 'Environment');

    // Sun Latitude slider — single authoritative value consumed by
    // OverheadShadowsEffect, BuildingShadowsEffect, WindowLightEffect,
    // LightingEffect, TreeEffect, and BushEffect.
    const onSunLatitudeChange = (ev) => {
      this.globalParams.sunLatitude = ev.value;
      this.onGlobalChange('sunLatitude', ev.value);
    };
    this._uiValidatorGlobalHandlers.sunLatitude = onSunLatitudeChange;

    this._sunLatitudeBinding = envFolder.addBinding(this.globalParams, 'sunLatitude', {
      label: 'Sun Latitude',
      min: 0.0,
      max: 1.0,
      step: 0.01
    }).on('change', onSunLatitudeChange);

    envFolder.on('fold', (ev) => {
      this.accordionStates['cat_environment'] = ev.expanded;
      this.saveUIState();
    });
  }

  buildDebugSection() {
    if (!this.pane) return;
    if (this._debugFolder) return;

    const debugFolder = this.pane.addFolder({
      title: 'Developer Tools',
      expanded: this.accordionStates['debug'] ?? false
    });

    this._debugFolder = debugFolder;

    const uiFolder = debugFolder.addFolder({
      title: 'UI',
      expanded: this.accordionStates['debug_ui'] ?? false
    });

    this._uiValidatorButton = uiFolder.addButton({
      title: 'Run UI Validator'
    });

    this._uiValidatorButton.on('click', async () => {
      await this.runUIValidator();
    });

    uiFolder.on('fold', (ev) => {
      this.accordionStates['debug_ui'] = ev.expanded;
      this.saveUIState();
    });

    debugFolder.addBlade({ view: 'separator' });

    const settingsFolder = debugFolder.addFolder({
      title: 'Settings',
      expanded: this.accordionStates['debug_settings'] ?? false
    });

    settingsFolder.addButton({
      title: 'Copy Non-Default Settings'
    }).on('click', async () => {
      await this.copyNonDefaultSettingsToClipboard();
    });

    settingsFolder.addButton({
      title: 'Copy Changed This Session'
    }).on('click', async () => {
      await this.copyChangedSettingsToClipboard();
    });

    settingsFolder.addButton({
      title: 'Copy Current Settings'
    }).on('click', async () => {
      await this.copyCurrentSettingsToClipboard();
    });

    settingsFolder.on('fold', (ev) => {
      this.accordionStates['debug_settings'] = ev.expanded;
      this.saveUIState();
    });

    debugFolder.addBlade({ view: 'separator' });

    const sceneFolder = debugFolder.addFolder({
      title: 'Scene',
      expanded: this.accordionStates['debug_scene'] ?? false
    });

    sceneFolder.addButton({
      title: 'Dump Surface Report'
    }).on('click', () => {
      try {
        const report = window.MapShine?.surfaceRegistry?.refresh?.() || window.MapShine?.surfaceReport;
        if (!report) {
          ui.notifications?.warn?.('Map Shine: Surface Report not available');
          return;
        }

        const surfaces = Array.isArray(report.surfaces) ? report.surfaces : [];
        const stacks = Array.isArray(report.stacks) ? report.stacks : [];

        console.groupCollapsed('Map Shine: Surface Report');
        console.log('scene', report.scene);
        console.log('stacks', stacks);

        const rows = surfaces.map((s) => ({
          surfaceId: s?.surfaceId,
          source: s?.source,
          kind: s?.kind,
          roof: s?.roof,
          stackId: s?.stackId,
          elevation: s?.elevation,
          hidden: s?.hidden,
          bypassPostFX: s?.flags?.bypassPostFX,
          cloudShadowsEnabled: s?.flags?.cloudShadowsEnabled,
          cloudTopsEnabled: s?.flags?.cloudTopsEnabled,
          occludesWater: s?.flags?.occludesWater,
          threeHasObject: s?.three?.hasObject,
          threeIsOverhead: s?.three?.isOverhead,
          threeIsWeatherRoof: s?.three?.isWeatherRoof,
          layersMask: s?.three?.layersMask
        }));

        console.table(rows);
        console.groupEnd();
      } catch (e) {
        console.warn('Map Shine: Failed to dump Surface Report', e);
      }
    });

    sceneFolder.on('fold', (ev) => {
      this.accordionStates['debug_scene'] = ev.expanded;
      this.saveUIState();
    });

    debugFolder.on('fold', (ev) => {
      this.accordionStates['debug'] = ev.expanded;
      this.saveUIState();
    });
  }

  buildRopesSection() {
    if (!this.pane) return;
    if (this._ropesFolder) return;
    try {
      const existing = this.pane.element?.textContent;
      if (typeof existing === 'string' && existing.includes('Ropes')) {
        return;
      }
    } catch (e) {
    }

    const particleParent = this.ensureCategoryFolder('particle', 'Particles & VFX');

    const folder = particleParent.addFolder({
      title: 'Rope & Chain',
      expanded: this.accordionStates['ropes'] ?? false
    });

    this._ropesFolder = folder;

    try {
      const saved = game.settings.get('map-shine-advanced', 'rope-default-textures');
      if (saved && typeof saved === 'object') {
        if (typeof saved.ropeTexturePath === 'string') this.ropeDefaults.ropeTexturePath = saved.ropeTexturePath;
        if (typeof saved.chainTexturePath === 'string') this.ropeDefaults.chainTexturePath = saved.chainTexturePath;
      }
    } catch (e) {
    }

    try {
      const saved = game.settings.get('map-shine-advanced', 'rope-default-behavior');
      if (saved && typeof saved === 'object') {
        for (const key of ['rope', 'chain']) {
          const s = saved[key];
          const t = this.ropeBehaviorDefaults[key];
          if (!s || typeof s !== 'object' || !t) continue;
          for (const k of Object.keys(t)) {
            if (typeof s[k] === 'number' && Number.isFinite(s[k])) t[k] = s[k];
          }
        }
      }
    } catch (e) {
    }

    const saveAndRebuild = async () => {
      try {
        await game.settings.set('map-shine-advanced', 'rope-default-textures', {
          ropeTexturePath: String(this.ropeDefaults.ropeTexturePath || ''),
          chainTexturePath: String(this.ropeDefaults.chainTexturePath || '')
        });
      } catch (e) {
      }

      try {
        await game.settings.set('map-shine-advanced', 'rope-default-behavior', {
          rope: { ...this.ropeBehaviorDefaults.rope },
          chain: { ...this.ropeBehaviorDefaults.chain }
        });
      } catch (e) {
      }

      try {
        window.MapShine?.physicsRopeManager?.requestRebuild?.();
      } catch (e) {
      }
    };

    const onRopeTextureChange = (ev) => {
      this.ropeDefaults.ropeTexturePath = ev.value;
      void saveAndRebuild();
    };

    const onChainTextureChange = (ev) => {
      this.ropeDefaults.chainTexturePath = ev.value;
      void saveAndRebuild();
    };

    folder.addBinding(this.ropeDefaults, 'ropeTexturePath', { label: 'Rope Texture' }).on('change', onRopeTextureChange);
    folder.addButton({ title: 'Browse Rope Texture' }).on('click', async () => {
      const filePickerImpl = globalThis.foundry?.applications?.apps?.FilePicker?.implementation;
      const FilePickerCls = filePickerImpl ?? globalThis.FilePicker;
      if (!FilePickerCls) {
        ui.notifications?.warn?.('FilePicker not available');
        return;
      }

      const fp = new FilePickerCls({
        type: 'image',
        current: this.ropeDefaults.ropeTexturePath || '',
        callback: async (path) => {
          this.ropeDefaults.ropeTexturePath = path;
          void saveAndRebuild();
        }
      });
      fp.browse();
    });

    folder.addBlade({ view: 'separator' });

    folder.addBinding(this.ropeDefaults, 'chainTexturePath', { label: 'Chain Texture' }).on('change', onChainTextureChange);
    folder.addButton({ title: 'Browse Chain Texture' }).on('click', async () => {
      const filePickerImpl = globalThis.foundry?.applications?.apps?.FilePicker?.implementation;
      const FilePickerCls = filePickerImpl ?? globalThis.FilePicker;
      if (!FilePickerCls) {
        ui.notifications?.warn?.('FilePicker not available');
        return;
      }

      const fp = new FilePickerCls({
        type: 'image',
        current: this.ropeDefaults.chainTexturePath || '',
        callback: async (path) => {
          this.ropeDefaults.chainTexturePath = path;
          void saveAndRebuild();
        }
      });
      fp.browse();
    });

    folder.on('fold', (ev) => {
      this.accordionStates['ropes'] = ev.expanded;
      this.saveUIState();
    });

    folder.addBlade({ view: 'separator' });

    const ropeFolder = folder.addFolder({
      title: 'Rope Defaults',
      expanded: this.accordionStates['ropes_defaults_rope'] ?? false
    });
    const chainFolder = folder.addFolder({
      title: 'Chain Defaults',
      expanded: this.accordionStates['ropes_defaults_chain'] ?? false
    });

    ropeFolder.on('fold', (ev) => {
      this.accordionStates['ropes_defaults_rope'] = ev.expanded;
      this.saveUIState();
    });
    chainFolder.on('fold', (ev) => {
      this.accordionStates['ropes_defaults_chain'] = ev.expanded;
      this.saveUIState();
    });

    const bindDefaults = (container, obj) => {
      container.addBlade({ view: 'separator' });
      container.addBinding(obj, 'segmentLength', { label: 'Segment Length', min: 4, max: 64, step: 1 }).on('change', saveAndRebuild);
      
      container.addBlade({ view: 'separator' });
      container.addBinding(obj, 'damping', { label: 'Damping', min: 0.8, max: 0.999, step: 0.001 }).on('change', saveAndRebuild);
      
      container.addBlade({ view: 'separator' });
      container.addBinding(obj, 'windForce', { label: 'Wind Force', min: 0, max: 4, step: 0.05 }).on('change', saveAndRebuild);
      container.addBinding(obj, 'windGustAmount', { label: 'Wind Gust Amount', min: 0, max: 1, step: 0.05 }).on('change', saveAndRebuild);
      if (Object.prototype.hasOwnProperty.call(obj, 'invertWindDirection')) {
        container.addBinding(obj, 'invertWindDirection', { label: 'Invert Wind Direction' }).on('change', saveAndRebuild);
      }
      
      container.addBlade({ view: 'separator' });
      container.addBinding(obj, 'gravityStrength', { label: 'Gravity Strength', min: 0, max: 2, step: 0.05 }).on('change', saveAndRebuild);
      container.addBinding(obj, 'slackFactor', { label: 'Slack Factor', min: 1.0, max: 2.0, step: 0.05 }).on('change', saveAndRebuild);
      
      container.addBlade({ view: 'separator' });
      container.addBinding(obj, 'bendStiffness', { label: 'Bend Stiffness', min: 0, max: 2, step: 0.01 }).on('change', saveAndRebuild);
      container.addBinding(obj, 'constraintIterations', { label: 'Constraint Iterations', min: 1, max: 20, step: 1 }).on('change', saveAndRebuild);
      
      container.addBlade({ view: 'separator' });
      container.addBinding(obj, 'width', { label: 'Width', min: 2, max: 80, step: 1 }).on('change', saveAndRebuild);
      container.addBinding(obj, 'tapering', { label: 'Tapering', min: 0, max: 1, step: 0.01 }).on('change', saveAndRebuild);
      container.addBinding(obj, 'uvRepeatWorld', { label: 'UV Repeat (px)', min: 4, max: 256, step: 1 }).on('change', saveAndRebuild);
      
      container.addBlade({ view: 'separator' });
      container.addBinding(obj, 'windowLightBoost', { label: 'Window Light Boost', min: 0, max: 50, step: 0.25 }).on('change', saveAndRebuild);
      container.addBinding(obj, 'endFadeSize', { label: 'End Fade Size', min: 0, max: 0.5, step: 0.01 }).on('change', saveAndRebuild);
      container.addBinding(obj, 'endFadeStrength', { label: 'End Fade Strength', min: 0, max: 1, step: 0.01 }).on('change', saveAndRebuild);
    };

    bindDefaults(ropeFolder, this.ropeBehaviorDefaults.rope);
    bindDefaults(chainFolder, this.ropeBehaviorDefaults.chain);
  }
  
  onMasterResetToDefaults() {
    // Capture current state so we can undo
    this.captureMasterResetSnapshot();

    // Reset all registered effects to their schema defaults without per-effect notifications
    for (const [effectId] of Object.entries(this.effectFolders)) {
      this.resetEffectToDefaultsInternal(effectId, false);
    }

    // Reset global controls to their defaults
    this.globalParams.mapMakerMode = false;
    this.globalParams.timeRate = 100;
    this.globalParams.sunLatitude = 0.1;

    // Reset UI scale
    this.uiScale = 1.0;
    this.uiScaleParams.scale = 1.0;
    this.updateScale();
    this.saveUIState();

    // Propagate global control changes to the underlying systems
    this.onGlobalChange('mapMakerMode', this.globalParams.mapMakerMode);
    this.onGlobalChange('timeRate', this.globalParams.timeRate);
    this.onGlobalChange('sunLatitude', this.globalParams.sunLatitude);

    // Queue saves for all effects so scene flags are updated
    for (const [effectId] of Object.entries(this.effectFolders)) {
      this.queueSave(effectId);
    }

    // Refresh pane visuals
    if (this.pane) {
      this.pane.refresh();
    }

    ui.notifications.info('Map Shine: All effects reset to defaults');
  }

  onUndoMasterReset() {
    if (!this.lastMasterResetSnapshot) {
      ui.notifications.warn('Map Shine: Nothing to undo');
      return;
    }

    this.applyMasterResetSnapshot();

    if (this.pane) {
      this.pane.refresh();
    }

    ui.notifications.info('Map Shine: Previous settings restored');
  }

  captureMasterResetSnapshot() {
    const effects = {};
    for (const [effectId, effectData] of Object.entries(this.effectFolders)) {
      effects[effectId] = {
        params: { ...effectData.params }
      };
    }

    this.lastMasterResetSnapshot = {
      globalParams: { ...this.globalParams },
      uiScale: this.uiScale,
      settingsMode: this.settingsMode,
      effects
    };

    this.updateUndoButtonState();
  }

  applyMasterResetSnapshot() {
    const snapshot = this.lastMasterResetSnapshot;
    if (!snapshot) return;

    // Restore globals
    this.globalParams.mapMakerMode = snapshot.globalParams.mapMakerMode;
    this.globalParams.timeRate = snapshot.globalParams.timeRate;
    this.globalParams.sunLatitude = snapshot.globalParams.sunLatitude ?? 0.1;

    // Restore UI scale
    this.uiScale = snapshot.uiScale ?? 1.0;
    this.uiScaleParams.scale = this.uiScale;
    this.updateScale();
    this.saveUIState();

    // Propagate global control changes
    this.onGlobalChange('mapMakerMode', this.globalParams.mapMakerMode);
    this.onGlobalChange('timeRate', this.globalParams.timeRate);
    this.onGlobalChange('sunLatitude', this.globalParams.sunLatitude);

    // Restore each effect's parameters and notify callbacks
    for (const [effectId, effectSnapshot] of Object.entries(snapshot.effects || {})) {
      const effectData = this.effectFolders[effectId];
      if (!effectData) continue;

      const params = effectSnapshot.params || {};
      for (const [paramId, value] of Object.entries(params)) {
        const def = effectData.schema?.parameters?.[paramId];
        if (def?.readonly === true) continue;
        if (def?.hidden === true && paramId !== 'enabled') continue;
        effectData.params[paramId] = value;

        if (effectData.bindings[paramId]) {
          effectData.bindings[paramId].refresh();
        }

        const callback = this.effectCallbacks.get(effectId);
        if (callback) {
          callback(effectId, paramId, value);
        }
      }

      this.updateEffectiveState(effectId);
      this.updateControlStates(effectId);
      this.queueSave(effectId);
    }
  }

  updateUndoButtonState() {
    if (this.undoButton) {
      this.undoButton.disabled = !this.lastMasterResetSnapshot;
    }
  }

  /**
   * Build scene setup section (GM only)
   * @private
   */
  buildSceneSetupSection() {
    const setupFolder = this.pane.addFolder({
      title: 'Scene Setup',
      expanded: this.accordionStates['sceneSetup'] ?? true
    });

    // Settings mode selector
    const modeParams = {
      mode: this.settingsMode
    };

    setupFolder.addBinding(modeParams, 'mode', {
      label: 'Settings Mode',
      options: {
        'Map Maker': 'mapMaker',
        'GM Override': 'gm'
      }
    }).on('change', (ev) => {
      this.setSettingsMode(ev.value);
    });

    // Revert to Map Maker button
    setupFolder.addButton({
      title: 'Revert to Original'
    }).on('click', () => {
      this.revertToMapMaker();
    });

    setupFolder.addButton({
      title: 'Publish Scene Settings (Compendium)'
    }).on('click', async () => {
      await this.publishSceneSettingsToMap();
    });

    // Enable / Upgrade Map Shine Advanced for this scene
    const scene = canvas?.scene;
    const isEnabled = !!scene && scene.getFlag('map-shine-advanced', 'enabled') === true;
    // Legacy v1.x module used the "map-shine" flag scope. On newer
    // Foundry versions, getFlag will throw if that scope is not
    // registered, so we must guard this in a try/catch.
    let hasLegacy = false;
    if (scene) {
      try {
        hasLegacy = scene.getFlag('map-shine', 'enabled') === true;
      } catch (e) {
        // Flag scope not available; treat as no legacy data present.
        hasLegacy = false;
      }
    }

    if (scene) {
      if (isEnabled) {
        // Show a disabled status button when already enabled
        const statusButton = setupFolder.addButton({
          title: 'Map Shine Advanced Enabled'
        });
        statusButton.disabled = true;
      } else {
        const title = hasLegacy
          ? 'Upgrade Scene to Map Shine Advanced'
          : 'Enable Map Shine Advanced for this Scene';

        const enableButton = setupFolder.addButton({
          title
        });

        enableButton.on('click', async () => {
          const s = canvas?.scene;
          if (!s) {
            ui.notifications?.warn?.('Map Shine: No active scene to enable.');
            return;
          }

          try {
            await sceneSettings.enable(s);
            ui.notifications?.info?.('Map Shine: Scene enabled for Map Shine Advanced. Reloading Foundry to activate the 3D canvas...');

            setTimeout(() => {
              try {
                const utils = globalThis.foundry?.utils;
                if (typeof utils?.debouncedReload === 'function') {
                  utils.debouncedReload();
                } else {
                  globalThis.location?.reload?.();
                }
              } catch (e) {
                globalThis.location?.reload?.();
              }
            }, 250);
          } catch (e) {
            log.error('Failed to enable Map Shine Advanced for scene:', e);
            ui.notifications?.error?.('Map Shine: Failed to enable this scene. Check console for details.');
          }
        });
      }
    }

    // Track accordion state
    setupFolder.on('fold', (ev) => {
      this.accordionStates['sceneSetup'] = ev.expanded;
      this.saveUIState();
    });
  }

  /**
   * Build branding/support section
   * @private
   */
  buildBrandingSection() {
    const brandingFolder = this.pane.addFolder({
      title: 'Support & Links',
      expanded: true
    });

    // Add HTML element for links
    const linkContainer = document.createElement('div');
    linkContainer.style.padding = '8px';
    linkContainer.style.fontSize = '12px';
    linkContainer.innerHTML = `
      <div style="margin-bottom: 10px;">
        <a href="https://github.com/Garsondee/map-shine-advanced/issues" target="_blank" style="color: #66aaff;">
          🐞 Report a Bug
        </a>
      </div>
      <div style="margin-bottom: 8px;">
        <strong>Support Development:</strong>
      </div>
      <div style="margin-bottom: 4px;">
        <a href="https://www.patreon.com/c/MythicaMachina" target="_blank" style="color: #ff424d;">
          ❤️ Patreon
        </a>
      </div>
      <div>
        <a href="https://www.foundryvtt.store/creators/mythica-machina" target="_blank" style="color: #ff6400;">
          🛒 Foundry Store
        </a>
      </div>
    `;

    // Append into the folder's collapsible content area so it folds correctly
    const contentElement = brandingFolder.element.querySelector('.tp-fldv_c') || brandingFolder.element;
    contentElement.appendChild(linkContainer);

    // Track accordion state
    brandingFolder.on('fold', (ev) => {
      this.accordionStates['branding'] = ev.expanded;
      this.saveUIState();

      if (!ev.expanded) {
        setTimeout(() => {
          try {
            brandingFolder.expanded = true;
          } catch (e) {
          }
        }, 0);
      }
    });
  }

  /**
   * Ensure a category folder exists
   * @param {string} categoryId - Unique category identifier
   * @param {string} title - Display title
   * @returns {any} Tweakpane folder instance
   */
  ensureCategoryFolder(categoryId, title) {
    if (this.categoryFolders[categoryId]) {
      return this.categoryFolders[categoryId];
    }

    const folder = this.pane.addFolder({
      title: title,
      expanded: this.accordionStates[`cat_${categoryId}`] ?? false
    });

    try {
      const debugEl = this._debugFolder?.element;
      const folderEl = folder?.element;
      if (debugEl && folderEl && debugEl.parentNode && debugEl.parentNode === folderEl.parentNode) {
        debugEl.parentNode.insertBefore(folderEl, debugEl);
      }
    } catch (e) {
    }

    folder.on('fold', (ev) => {
      this.accordionStates[`cat_${categoryId}`] = ev.expanded;
      this.saveUIState();
    });

    this.categoryFolders[categoryId] = folder;
    return folder;
  }

  registerEffectUnderEffect(parentEffectId, effectId, effectName, schema, updateCallback) {
    const parentEffect = this.effectFolders[parentEffectId];
    if (!parentEffect?.folder) {
      this.registerEffect(effectId, effectName, schema, updateCallback, null);
      return;
    }

    if (this.effectFolders[effectId]) {
      log.warn(`Effect ${effectId} already registered`);
      return;
    }

    log.info(`Registering effect: ${effectName}`);

    const folder = parentEffect.folder.addFolder({
      title: effectName,
      expanded: this.accordionStates[effectId] ?? false
    });

    this.effectFolders[effectId] = {
      folder,
      params: {},
      bindings: {},
      schema,
      statusElement: null,
      dependencyState: {}
    };

    if (!schema.parameters) schema.parameters = {};
    if (!schema.parameters.enabled) {
      schema.parameters.enabled = {
        type: 'boolean',
        default: schema.enabled ?? true,
        hidden: true
      };
    }

    const savedParams = this.loadEffectParameters(effectId, schema);
    const validation = globalValidator.validateAllParameters(effectId, savedParams, schema);
    if (!validation.valid) {
      log.warn(`${effectId} initial validation failed:`, validation.errors);
    }
    const validatedParams = validation.params;

    this.addStatusIndicator(effectId, folder);

    if (schema.presets && typeof schema.presets === 'object') {
      const presetKeys = Object.keys(schema.presets);
      if (presetKeys.length > 0) {
        const presetState = { preset: 'Custom' };
        const presetOptions = { Custom: 'Custom' };
        for (const key of presetKeys) {
          presetOptions[key] = key;
        }

        const presetBinding = folder.addBinding(presetState, 'preset', {
          label: 'Preset',
          options: presetOptions
        });

        presetBinding.on('change', (ev) => {
          const selected = ev.value;
          if (selected === 'Custom') return;
          const presetDef = schema.presets[selected];
          if (!presetDef) return;

          const effectData = this.effectFolders[effectId];
          if (!effectData) return;

          const callback = this.effectCallbacks.get(effectId) || updateCallback;
          if (callback) {
            callback(effectId, '_preset_begin', selected);
          }

          // Optional preset teardown: reset any parameters not explicitly mentioned in the preset.
          // This prevents feature flags from "sticking" when switching between presets.
          if (schema.presetApplyDefaults === true) {
            for (const [paramId, paramDef] of Object.entries(schema.parameters || {})) {
              if (paramId === 'enabled') continue;
              if (!paramDef || !Object.prototype.hasOwnProperty.call(paramDef, 'default')) continue;

              effectData.params[paramId] = paramDef.default;

              if (effectData.bindings[paramId]) {
                effectData.bindings[paramId].refresh();
              }

              if (callback) {
                callback(effectId, paramId, paramDef.default);
              }
            }
          }

          for (const [paramId, value] of Object.entries(presetDef)) {
            const paramDef = schema.parameters?.[paramId];
            if (!paramDef) continue;

            const result = globalValidator.validateParameter(paramId, value, paramDef);
            const finalValue = result.valid ? result.value : paramDef.default;

            effectData.params[paramId] = finalValue;

            if (effectData.bindings[paramId]) {
              effectData.bindings[paramId].refresh();
            }

            if (callback) {
              callback(effectId, paramId, finalValue);
            }
          }

          if (callback) {
            callback(effectId, '_preset_end', selected);
          }

          this.updateEffectiveState(effectId);
          this.updateControlStates(effectId);
          this.runSanityCheck(effectId);
          this.queueSave(effectId);
        });
      }
    }

    this.effectFolders[effectId].params.enabled = savedParams.enabled ?? schema.enabled ?? true;
    const enableBinding = folder.addBinding(
      this.effectFolders[effectId].params,
      'enabled',
      { label: 'Enabled' }
    );

    const handleEnabledChange = (ev) => {
      this.markDirty(effectId, 'enabled');
      updateCallback(effectId, 'enabled', ev.value);
      this.updateEffectiveState(effectId);
      this.updateControlStates(effectId);
      this.queueSave(effectId);
    };

    const effectDataForHandlers = this.effectFolders[effectId];
    if (effectDataForHandlers) {
      if (!effectDataForHandlers._uiValidatorHandlers) effectDataForHandlers._uiValidatorHandlers = {};
      effectDataForHandlers._uiValidatorHandlers.enabled = handleEnabledChange;
    }

    enableBinding.on('change', this.throttle(handleEnabledChange, 100));

    this.buildEffectControls(effectId, folder, schema, updateCallback, validatedParams);

    const effectData = this.effectFolders[effectId];
    const initialCallback = this.effectCallbacks.get(effectId) || updateCallback;
    if (initialCallback && effectData && effectData.params) {
      for (const [paramId, value] of Object.entries(effectData.params)) {
        initialCallback(effectId, paramId, value);
      }
    }

    this.updateEffectiveState(effectId);
    this.updateControlStates(effectId);

    folder.addButton({
      title: '🔄 Reset to Defaults'
    }).on('click', () => {
      this.resetEffectToDefaults(effectId);
    });

    this.effectCallbacks.set(effectId, updateCallback);

    folder.on('fold', (ev) => {
      this.accordionStates[effectId] = ev.expanded;
      this.saveUIState();
    });
  }

  /**
   * Register an effect with the UI
   * @param {string} effectId - Unique effect identifier
   * @param {string} effectName - Display name
   * @param {Object} schema - Effect control schema
   * @param {Function} updateCallback - Called when parameters change
   * @param {string} [categoryId] - Optional category ID to group effect under
   */
  registerEffect(effectId, effectName, schema, updateCallback, categoryId = null) {
    if (this.effectFolders[effectId]) {
      log.warn(`Effect ${effectId} already registered`);
      return;
    }

    log.info(`Registering effect: ${effectName}`);

    // Determine parent container (category folder or main pane)
    let parent = this.pane;
    if (categoryId) {
      const titles = {
        environment: 'Environment',
        atmospheric: 'Atmospheric & Environmental',
        surface: 'Surface & Material',
        water: 'Water',
        structure: 'Objects & Structures',
        particle: 'Particles & VFX',
        ash: 'Ash',
        global: 'Global & Post',
        debug: 'Debug'
      };
      const title = titles[categoryId] || categoryId;
      parent = this.ensureCategoryFolder(categoryId, title);
    }

    const folder = parent.addFolder({
      title: effectName,
      expanded: this.accordionStates[effectId] ?? false
    });

    this.effectFolders[effectId] = {
      folder,
      params: {},
      bindings: {},
      schema,
      statusElement: null,
      dependencyState: {}
    };

    if (!schema.parameters) schema.parameters = {};
    if (!schema.parameters.enabled) {
      schema.parameters.enabled = {
        type: 'boolean',
        default: schema.enabled ?? true,
        hidden: true
      };
    }

    const savedParams = this.loadEffectParameters(effectId, schema);
    const validation = globalValidator.validateAllParameters(effectId, savedParams, schema);
    if (!validation.valid) {
      log.warn(`${effectId} initial validation failed:`, validation.errors);
    }
    const validatedParams = validation.params;

    this.addStatusIndicator(effectId, folder);

    // Preset dropdown just under header
    if (schema.presets && typeof schema.presets === 'object') {
      const presetKeys = Object.keys(schema.presets);
      if (presetKeys.length > 0) {
        const presetState = { preset: 'Custom' };
        const presetOptions = { Custom: 'Custom' };
        for (const key of presetKeys) {
          presetOptions[key] = key;
        }

        const presetBinding = folder.addBinding(presetState, 'preset', {
          label: 'Preset',
          options: presetOptions
        });

        presetBinding.on('change', (ev) => {
          const selected = ev.value;
          if (selected === 'Custom') return;
          const presetDef = schema.presets[selected];
          if (!presetDef) return;

          const effectData = this.effectFolders[effectId];
          if (!effectData) return;

          const callback = this.effectCallbacks.get(effectId) || updateCallback;
          if (callback) {
            callback(effectId, '_preset_begin', selected);
          }

          // Optional preset teardown: reset any parameters not explicitly mentioned in the preset.
          // This prevents feature flags from "sticking" when switching between presets.
          if (schema.presetApplyDefaults === true) {
            for (const [paramId, paramDef] of Object.entries(schema.parameters || {})) {
              if (paramId === 'enabled') continue;
              if (!paramDef || !Object.prototype.hasOwnProperty.call(paramDef, 'default')) continue;

              effectData.params[paramId] = paramDef.default;

              if (effectData.bindings[paramId]) {
                effectData.bindings[paramId].refresh();
              }

              if (callback) {
                callback(effectId, paramId, paramDef.default);
              }
            }
          }

          for (const [paramId, value] of Object.entries(presetDef)) {
            const paramDef = schema.parameters?.[paramId];
            if (!paramDef) continue;

            const result = globalValidator.validateParameter(paramId, value, paramDef);
            const finalValue = result.valid ? result.value : paramDef.default;

            effectData.params[paramId] = finalValue;

            if (effectData.bindings[paramId]) {
              effectData.bindings[paramId].refresh();
            }

            if (callback) {
              callback(effectId, paramId, finalValue);
            }
          }

          if (callback) {
            callback(effectId, '_preset_end', selected);
          }

          this.updateEffectiveState(effectId);
          this.updateControlStates(effectId);
          this.runSanityCheck(effectId);
          this.queueSave(effectId);
        });
      }
    }

    // Enabled toggle
    this.effectFolders[effectId].params.enabled = savedParams.enabled ?? schema.enabled ?? true;
    const enableBinding = folder.addBinding(
      this.effectFolders[effectId].params,
      'enabled',
      { label: 'Enabled' }
    );

    const handleEnabledChange = (ev) => {
      this.markDirty(effectId, 'enabled');
      updateCallback(effectId, 'enabled', ev.value);
      this.updateEffectiveState(effectId);
      this.updateControlStates(effectId);
      this.queueSave(effectId);
    };

    const effectDataForHandlers = this.effectFolders[effectId];
    if (effectDataForHandlers) {
      if (!effectDataForHandlers._uiValidatorHandlers) effectDataForHandlers._uiValidatorHandlers = {};
      effectDataForHandlers._uiValidatorHandlers.enabled = handleEnabledChange;
    }

    enableBinding.on('change', this.throttle(handleEnabledChange, 100));

    // Build controls from schema
    this.buildEffectControls(effectId, folder, schema, updateCallback, validatedParams);

    // Push initial parameter values into the effect so it starts in sync
    const effectData = this.effectFolders[effectId];
    const initialCallback = this.effectCallbacks.get(effectId) || updateCallback;
    if (initialCallback && effectData && effectData.params) {
      for (const [paramId, value] of Object.entries(effectData.params)) {
        const def = effectData.schema?.parameters?.[paramId];
        // Do not push readonly (status-only) or hidden parameters into the effect.
        // These are typically driven by the effect itself (e.g. texture discovery state)
        // and pushing UI defaults can clobber authoritative runtime values.
        if (def?.readonly === true) continue;
        if (def?.hidden === true && paramId !== 'enabled') continue;

        initialCallback(effectId, paramId, value);
      }
    }

    this.updateEffectiveState(effectId);
    this.updateControlStates(effectId);

    folder.addButton({
      title: '🔄 Reset to Defaults'
    }).on('click', () => {
      this.resetEffectToDefaults(effectId);
    });

    this.effectCallbacks.set(effectId, updateCallback);

    folder.on('fold', (ev) => {
      this.accordionStates[effectId] = ev.expanded;
      this.saveUIState();
    });
  }

  /**
   * Build effect controls based on schema groups or flat structure
   * @private
   */
  buildEffectControls(effectId, folder, schema, updateCallback, savedParams) {
    if (schema.groups) {
      for (const group of schema.groups) {
        // Add separator before this group if requested
        if (group.separator) {
          folder.addBlade({ view: 'separator' });
        }

        // Determine target container (inline vs nested folder)
        let targetContainer = folder;
        if (group.type === 'folder') {
          // Create nested folder for this group
          targetContainer = folder.addFolder({
            title: group.label,
            expanded: group.expanded ?? false
          });
        }

        // Build controls for this group's parameters
        for (const paramId of group.parameters) {
          const paramDef = schema.parameters[paramId];
          if (!paramDef) {
            log.warn(`Parameter ${paramId} not found in schema`);
            continue;
          }

          this.buildParameterControl(
            effectId,
            targetContainer,
            paramId,
            paramDef,
            updateCallback,
            savedParams
          );
        }
      }
    } else {
      // Fallback: flat structure (legacy compatibility)
      for (const [paramId, paramDef] of Object.entries(schema.parameters || {})) {
        this.buildParameterControl(
          effectId,
          folder,
          paramId,
          paramDef,
          updateCallback,
          savedParams
        );
      }
    }
  }

  /**
   * Build a single parameter control with validation and change handling
   * @private
   */
  buildParameterControl(effectId, container, paramId, paramDef, updateCallback, savedParams) {
    const effectData = this.effectFolders[effectId];

    if (paramDef?.gmOnly === true && !game.user.isGM) {
      return;
    }

    if (paramDef?.type === 'button') {
      const title = paramDef.title || paramDef.label || paramId;
      const button = container.addButton({
        title,
        label: paramDef.label && paramDef.title ? paramDef.label : undefined
      });

      button.on('click', () => {
        try {
          updateCallback(effectId, paramId, true);
        } catch (e) {
        }
      });

      return;
    }

    // Use saved value if available, otherwise use default from schema
    effectData.params[paramId] = savedParams[paramId] ?? paramDef.default;

    // Determine control type
    const bindingOptions = {
      label: paramDef.label || paramId
    };

    // Check for dropdown options first
    if (paramDef.options) {
      bindingOptions.options = paramDef.options;
    } else {
      // Add constraints for numeric controls
      if (paramDef.min !== undefined) bindingOptions.min = paramDef.min;
      if (paramDef.max !== undefined) bindingOptions.max = paramDef.max;
      if (paramDef.step !== undefined) bindingOptions.step = paramDef.step;
    }

    // Create binding
    const binding = container.addBinding(
      effectData.params,
      paramId,
      bindingOptions
    );

    // Apply readonly state if requested
    if (paramDef.readonly) {
      binding.disabled = true;
    }

    effectData.bindings[paramId] = binding;
    
    // Store binding config for later enabling/disabling
    if (!effectData.bindingConfigs) effectData.bindingConfigs = {};
    effectData.bindingConfigs[paramId] = { binding, paramDef };

    const handleChange = (ev) => {
      // Validate new value
      const validation = globalValidator.validateParameter(paramId, ev.value, paramDef);
      
      if (!validation.valid) {
        log.error(`${effectId}.${paramId}: ${validation.error}`);
        ui.notifications.error(`Invalid value for ${paramDef.label || paramId}`);
        // Revert to previous valid value
        effectData.params[paramId] = paramDef.default;
        binding.refresh();
        return;
      }
      
      if (validation.warnings.length > 0) {
        log.warn(`${effectId}.${paramId}:`, validation.warnings);
      }
      
      // Use validated value and snap to the control's step grid for
      // numeric parameters so we avoid floating point noise like
      // 0.5000000001 when the UI is configured for step 0.01.
      let validValue = validation.value;
      if (typeof validValue === 'number' && typeof paramDef.step === 'number') {
        const step = paramDef.step;
        const snapped = Math.round(validValue / step) * step;
        // Crush tiny near-zero values to 0 to avoid -0 and 1e-17 noise.
        if (Math.abs(snapped) < step / 100) {
          validValue = 0;
        } else {
          validValue = snapped;
        }
      }

      effectData.params[paramId] = validValue;
      
      // Auto-disable/enable layers based on problematic values
      this.autoToggleLayerStates(effectId, paramId, validValue);
      
      this.markDirty(effectId, paramId);
      updateCallback(effectId, paramId, validValue);
      
      // Update effective state and control states
      this.updateEffectiveState(effectId);
      this.updateControlStates(effectId);
      
      this.queueSave(effectId);
      
      // Run sanity check on whole effect after change
      this.runSanityCheck(effectId);
    };

    if (!effectData._uiValidatorHandlers) effectData._uiValidatorHandlers = {};
    effectData._uiValidatorHandlers[paramId] = handleChange;

    // Throttled change handler with validation
    const throttleTime = paramDef.throttle || 100; // Default 100ms
    binding.on('change', this.throttle(handleChange, throttleTime));
  }

  /**
   * Handle global parameter changes
   * @private
   */
  onGlobalChange(param, value) {
    log.debug(`Global param changed: ${param} = ${value}`);
    
    if (param === 'mapMakerMode') {
      // Toggle Map Maker Mode (System Swap)
      if (window.MapShine?.setMapMakerMode) {
        window.MapShine.setMapMakerMode(value);
      } else {
        log.warn('setMapMakerMode not available on window.MapShine');
      }
    } else if (param === 'timeRate') {
      // Update TimeManager
      if (window.MapShine?.timeManager) {
        window.MapShine.timeManager.setScale(value / 100);
        log.debug(`Time scale set to ${(value / 100).toFixed(2)}x`);
      } else {
        log.warn('TimeManager not available, cannot set time rate');
      }
    } else if (param === 'showLightTranslateGizmo') {
      // Hide translate gizmo immediately if disabled
      const gizmoGroup = window.MapShine?.interactionManager?._lightTranslate?.group;
      if (!value && gizmoGroup) {
        gizmoGroup.visible = false;
      }
    } else if (param === 'showLightRadiusVisualization') {
      // Trigger a refresh of the enhanced light icon manager to update radius visualization visibility
      window.MapShine?.enhancedLightIconManager?.refreshAll?.();
    } else if (param === 'sunLatitude') {
      // Push global sun latitude to all effects that consume it.
      // This is the single source of truth — individual effect sliders have been removed.
      const lat = typeof value === 'number' ? value : 0.1;
      const ms = window.MapShine;
      if (ms?.overheadShadowsEffect?.params) ms.overheadShadowsEffect.params.sunLatitude = lat;
      if (ms?.buildingShadowsEffect?.params) ms.buildingShadowsEffect.params.sunLatitude = lat;
      if (ms?.windowLightEffect?.params) ms.windowLightEffect.params.sunLightLatitude = lat;
      log.debug(`Sun latitude pushed to all effects: ${lat}`);
    }

    this.saveUIState();
  }

  /**
   * Load effect parameters from scene settings (three-tier hierarchy)
   * @param {string} effectId - Effect identifier
   * @param {Object} schema - Effect schema with defaults
   * @returns {Object} Loaded parameters or defaults
   * @private
   */
  loadEffectParameters(effectId, schema) {
    try {
      const scene = canvas?.scene;
      if (!scene) {
        log.debug(`No active scene, using defaults for ${effectId}`);
        return {};
      }

      // Get all settings from scene flags
      const allSettings = scene.getFlag('map-shine-advanced', 'settings') || {};
      
      // Start with Map Maker settings
      const params = {};
      const resolveEffectKey = (id) => {
        if (id === 'window-light') return ['window-light', 'windowLight'];
        return [id];
      };

      const getTierEffectParams = (tier, id) => {
        const keys = resolveEffectKey(id);
        for (const k of keys) {
          const v = tier?.effects?.[k];
          if (v && typeof v === 'object') return v;
        }
        return {};
      };

      const base = getTierEffectParams(allSettings.mapMaker, effectId);
      const gm = (this.settingsMode === 'gm' ? getTierEffectParams(allSettings.gm, effectId) : {});
      const merged = this._deepMergeObjects(base, gm);

      // Materialize the params object in the schema's paramId namespace (including dotted IDs).
      const schemaParams = schema?.parameters || {};
      for (const paramId of Object.keys(schemaParams)) {
        const v = this._getProperty(merged, paramId);
        if (v !== undefined) params[paramId] = v;
      }

      // Apply player overrides (client-local, disable only)
      if (!game.user.isGM) {
        const playerOverrides = sceneSettings.getPlayerOverrides(scene);
        if (playerOverrides[effectId] !== undefined) {
          params.enabled = playerOverrides[effectId];
        }
      }

      log.debug(`Loaded parameters for ${effectId}:`, params);
      return params;
    } catch (error) {
      log.warn(`Failed to load parameters for ${effectId}:`, error);
      return {};
    }
  }

  /**
   * Queue effect for save (batched to avoid excessive scene flag writes)
   * @param {string} effectId - Effect to save
   * @private
   */
  queueSave(effectId) {
    if (this._uiValidatorActive) return;
    this.saveQueue.add(effectId);
  }

  /**
   * Save effect parameters to scene settings (respects three-tier hierarchy)
   * @param {string} effectId - Effect identifier
   * @returns {Promise<void>}
   * @private
   */
  async saveEffectParameters(effectId) {
    try {
      const scene = canvas?.scene;
      if (!scene) {
        log.warn(`Cannot save ${effectId}: no active scene`);
        return;
      }

      const effectData = this.effectFolders[effectId];
      if (!effectData) {
        log.warn(`Cannot save ${effectId}: effect not registered`);
        return;
      }

      // Get current parameters
      const schemaParams = effectData.schema?.parameters || {};
      const params = {};
      for (const [paramId, value] of Object.entries(effectData.params || {})) {
        const def = schemaParams[paramId];
        if (def?.readonly === true) continue;
        if (def?.hidden === true && paramId !== 'enabled') continue;
        const v = this._sanitizeSerializableValue(value);
        if (v === undefined) continue;
        this._setProperty(params, paramId, v);
      }

      // Get all settings
      const allSettings = scene.getFlag('map-shine-advanced', 'settings') || this.createDefaultSettings();

      // Save to appropriate tier based on user role and mode
      if (game.user.isGM) {
        // GM can save to Map Maker mode or GM override mode
        if (this.settingsMode === 'mapMaker') {
          // Save to Map Maker tier
          if (!allSettings.mapMaker) allSettings.mapMaker = { effects: {} };
          if (!allSettings.mapMaker.effects) allSettings.mapMaker.effects = {};
          allSettings.mapMaker.effects[effectId] = params;
          log.debug(`Saved ${effectId} to Map Maker tier`);
        } else if (this.settingsMode === 'gm') {
          // Save to GM override tier
          if (!allSettings.gm) allSettings.gm = { effects: {} };
          if (!allSettings.gm.effects) allSettings.gm.effects = {};
          allSettings.gm.effects[effectId] = params;
          log.debug(`Saved ${effectId} to GM override tier`);
        }

        // Write to scene flags
        await scene.setFlag('map-shine-advanced', 'settings', allSettings);
      } else {
        // Players can only save enabled/disabled to client settings
        const playerOverrides = sceneSettings.getPlayerOverrides(scene);
        playerOverrides[effectId] = params.enabled;
        await sceneSettings.savePlayerOverrides(scene, playerOverrides);
        log.debug(`Saved ${effectId} player override (enabled=${params.enabled})`);
      }
    } catch (error) {
      log.error(`Failed to save ${effectId}:`, error);
    }
  }

  /**
   * Flush the save queue (called by UI loop)
   * @private
   */
  async flushSaveQueue() {
    if (this._uiValidatorActive) return;
    if (this.saveQueue.size === 0) return;

    const now = performance.now();
    if (now - this.lastSave < this.saveDebounceMs) return;

    // Save all queued effects
    const toSave = Array.from(this.saveQueue);
    this.saveQueue.clear();
    this.lastSave = now;

    log.debug(`Flushing save queue: ${toSave.length} effect(s)`);

    for (const effectId of toSave) {
      await this.saveEffectParameters(effectId);
    }
  }

  _mergeEffectParams(base, override) {
    return this._deepMergeObjects(base, override);
  }

  _sanitizeSerializableValue(value) {
    if (value === undefined) return undefined;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return null;
      // Avoid -0 mismatches.
      if (Object.is(value, -0)) return 0;
    }
    return value;
  }

  _buildEffectiveEffectsSnapshot(allSettings) {
    const mapMakerEffects = allSettings?.mapMaker?.effects || {};
    const gmEffects = allSettings?.gm?.effects || {};

    const merged = {};

    // Start from all Map Maker effects.
    for (const [effectId, params] of Object.entries(mapMakerEffects)) {
      merged[effectId] = { ...(params || {}) };
    }

    // Apply GM overrides as a per-effect shallow merge (GM tier is sparse).
    for (const [effectId, gmParams] of Object.entries(gmEffects)) {
      merged[effectId] = this._mergeEffectParams(merged[effectId], gmParams);
    }

    // Finally, overwrite with current UI values for registered effects.
    // This ensures publishing always reflects the current on-screen state,
    // even if autosave debounce has not flushed yet.
    for (const [effectId, effectData] of Object.entries(this.effectFolders)) {
      const schemaParams = effectData.schema?.parameters || {};
      const params = {};
      for (const [paramId, value] of Object.entries(effectData.params || {})) {
        const def = schemaParams[paramId];
        if (def?.readonly === true) continue;
        if (def?.hidden === true && paramId !== 'enabled') continue;
        const v = this._sanitizeSerializableValue(value);
        if (v === undefined) continue;
        this._setProperty(params, paramId, v);
      }

      // Do not drop previously saved parameters which may not currently be exposed in the UI
      // (e.g. deprecated params, schema changes, or hidden/internal tuning). Publishing should
      // reproduce the scene exactly, so we preserve existing data and overlay current UI values.
      merged[effectId] = this._deepMergeObjects(merged[effectId], params);
    }

    return merged;
  }

  _stableStringify(value) {
    const seen = new WeakSet();
    const walk = (v) => {
      if (v === null || typeof v !== 'object') return v;
      if (seen.has(v)) return null;
      seen.add(v);

      if (Array.isArray(v)) return v.map(walk);

      const out = {};
      const keys = Object.keys(v).sort();
      for (const k of keys) out[k] = walk(v[k]);
      return out;
    };
    return JSON.stringify(walk(value));
  }

  _findFirstEffectsDiff(a, b) {
    const aObj = (a && typeof a === 'object') ? a : {};
    const bObj = (b && typeof b === 'object') ? b : {};

    const aEffects = Object.keys(aObj).sort();
    const bEffects = Object.keys(bObj).sort();
    const aSet = new Set(aEffects);
    const bSet = new Set(bEffects);

    for (const id of aEffects) {
      if (!bSet.has(id)) return { effectId: id, reason: 'missing_in_stored' };
    }
    for (const id of bEffects) {
      if (!aSet.has(id)) return { effectId: id, reason: 'extra_in_stored' };
    }

    for (const effectId of aEffects) {
      const pa = aObj[effectId] && typeof aObj[effectId] === 'object' ? aObj[effectId] : {};
      const pb = bObj[effectId] && typeof bObj[effectId] === 'object' ? bObj[effectId] : {};
      const ka = Object.keys(pa).sort();
      const kb = Object.keys(pb).sort();
      const kas = new Set(ka);
      const kbs = new Set(kb);

      for (const k of ka) {
        if (!kbs.has(k)) return { effectId, paramId: k, reason: 'param_missing_in_stored', a: pa[k] };
      }
      for (const k of kb) {
        if (!kas.has(k)) return { effectId, paramId: k, reason: 'param_extra_in_stored', b: pb[k] };
      }

      for (const k of ka) {
        const sa = this._stableStringify(pa[k]);
        const sb = this._stableStringify(pb[k]);
        if (sa !== sb) return { effectId, paramId: k, reason: 'param_value_mismatch', a: pa[k], b: pb[k] };
      }
    }

    return null;
  }

  /**
   * Publish the current scene's settings into the Map Maker tier so they export/import
   * with the Scene (compendium-friendly). Publishing always snapshots the CURRENT state
   * (including GM overrides and current weather), and then clears the GM override tier.
   *
   * @returns {Promise<void>}
   * @public
   */
  async publishSceneSettingsToMap() {
    const scene = canvas?.scene;
    if (!scene) {
      ui.notifications?.warn?.('Map Shine: No active scene to publish.');
      return;
    }

    if (!game?.user?.isGM) {
      ui.notifications?.warn?.('Map Shine: Only the GM can publish scene settings.');
      return;
    }

    if (this._uiValidatorActive) {
      ui.notifications?.warn?.('Map Shine: Cannot publish while validator is running.');
      return;
    }

    const startMs = Date.now();

    try {
      // Persist weather/time state first so the compendium export reproduces it exactly.
      const wc = window.MapShine?.weatherController || window.weatherController;
      if (wc?.saveWeatherSnapshotNow) {
        await wc.saveWeatherSnapshotNow();
      }
      if (wc?.saveDynamicStateNow) {
        await wc.saveDynamicStateNow();
      }
      if (wc?.saveQueuedTransitionTargetNow) {
        await wc.saveQueuedTransitionTargetNow();
      }

      // Also persist ControlPanel controlState if available (authoritative live-play state).
      // This is separate from weather-snapshot but helps reproduce the exact UI+authority state.
      try {
        const cs = window.MapShine?.controlPanel?.controlState;
        if (cs && typeof cs === 'object') {
          await scene.setFlag('map-shine-advanced', 'controlState', cs);
        }
      } catch (e) {
      }

      const current = scene.getFlag('map-shine-advanced', 'settings') || this.createDefaultSettings();

      const publishedEffects = this._buildEffectiveEffectsSnapshot(current);

      // Preserve non-effect settings that may exist (renderer/performance), but publish the
      // current EFFECT state as the compendium baseline.
      const nextSettings = {
        ...current,
        mapMaker: {
          ...(current.mapMaker || {}),
          enabled: true,
          version: (current.mapMaker?.version || '0.2.0'),
          effects: publishedEffects
        },
        gm: null
      };

      // Ensure the scene itself is enabled for Map Shine.
      await scene.setFlag('map-shine-advanced', 'enabled', true);
      await scene.setFlag('map-shine-advanced', 'settings', nextSettings);

      // Verify readback.
      const storedEnabled = scene.getFlag('map-shine-advanced', 'enabled') === true;
      const storedSettings = scene.getFlag('map-shine-advanced', 'settings');
      const storedEffects = storedSettings?.mapMaker?.effects || null;

      // Normalize for Foundry flag serialization (undefined keys are dropped).
      const okEffects = this._stableStringify(storedEffects) === this._stableStringify(publishedEffects);
      const okEnabled = storedEnabled === true;
      const okClearedGm = storedSettings?.gm === null;

      let okWeather = true;
      try {
        const ws = scene.getFlag('map-shine-advanced', 'weather-snapshot');
        if (!ws || typeof ws !== 'object') okWeather = false;
        else if (Number.isFinite(ws.updatedAt) && ws.updatedAt < startMs) okWeather = false;
      } catch (e) {
        okWeather = false;
      }

      if (!okEnabled || !okEffects || !okClearedGm || !okWeather) {
        const diff = okEffects ? null : this._findFirstEffectsDiff(publishedEffects, storedEffects);
        log.error('Scene publish verification failed', {
          okEnabled,
          okEffects,
          okClearedGm,
          okWeather,
          firstEffectsDiff: diff
        });
        ui.notifications?.error?.('Map Shine: Publish failed verification. Check console for details.');
        return;
      }

      ui.notifications?.info?.('Map Shine: Published scene settings (compendium-ready).');
    } catch (e) {
      log.error('Failed to publish scene settings:', e);
      ui.notifications?.error?.('Map Shine: Failed to publish scene settings. Check console for details.');
    }
  }

  /**
   * Create default settings structure
   * @returns {Object} Default settings
   * @private
   */
  createDefaultSettings() {
    return {
      mapMaker: {
        enabled: true,
        version: '0.2.0',
        effects: {},
        renderer: {
          antialias: true,
          pixelRatio: 'auto'
        },
        performance: {
          targetFPS: 30,
          adaptiveQuality: true
        }
      },
      gm: null,
      player: {}
    };
  }

  /**
   * Set settings mode (mapMaker or gm)
   * @param {string} mode - Settings mode
   * @public
   */
  setSettingsMode(mode) {
    if (mode !== 'mapMaker' && mode !== 'gm') {
      log.error(`Invalid settings mode: ${mode}`);
      return;
    }

    this.settingsMode = mode;
    log.info(`Settings mode set to: ${mode}`);

    // Reload all effect parameters from new tier
    this.reloadAllEffectParameters();
  }

  /**
   * Reload all effect parameters (used when switching modes)
   * @private
   */
  reloadAllEffectParameters() {
    for (const [effectId, effectData] of Object.entries(this.effectFolders)) {
      const savedParams = this.loadEffectParameters(effectId, effectData.schema);

      // Update params object
      for (const [paramId, value] of Object.entries(savedParams)) {
        const def = effectData.schema?.parameters?.[paramId];
        if (def?.readonly === true) continue;
        if (def?.hidden === true && paramId !== 'enabled') continue;
        if (effectData.params[paramId] !== undefined) {
          effectData.params[paramId] = value;
          
          // Refresh binding display
          if (effectData.bindings[paramId]) {
            effectData.bindings[paramId].refresh();
          }
        }
      }

      // Notify effect callback
      const callback = this.effectCallbacks.get(effectId);
      if (callback) {
        for (const [paramId, value] of Object.entries(savedParams)) {
          callback(effectId, paramId, value);
        }
      }
      
      // Update state indicators
      this.updateEffectiveState(effectId);
      this.updateControlStates(effectId);
    }

    log.info('All effect parameters reloaded');
  }

  /**
   * Reset an effect to its default values (safe mode recovery)
   * @param {string} effectId - Effect to reset
   * @public
   */
  resetEffectToDefaults(effectId) {
    this.resetEffectToDefaultsInternal(effectId, true);
  }

  resetEffectToDefaultsInternal(effectId, notify) {
    const effectData = this.effectFolders[effectId];
    if (!effectData) {
      log.error(`Cannot reset ${effectId}: effect not registered`);
      return;
    }

    log.info(`Resetting ${effectId} to defaults`);

    // Reset all parameters to schema defaults
    for (const [paramId, paramDef] of Object.entries(effectData.schema.parameters || {})) {
      if (paramDef?.readonly === true) continue;
      if (paramDef?.hidden === true && paramId !== 'enabled') continue;
      effectData.params[paramId] = paramDef.default;

      // Refresh UI binding
      if (effectData.bindings[paramId]) {
        effectData.bindings[paramId].refresh();
      }

      // Notify callback
      const callback = this.effectCallbacks.get(effectId);
      if (callback) {
        callback(effectId, paramId, paramDef.default);
      }
    }

    // Reset enabled state
    effectData.params.enabled = effectData.schema.enabled ?? true;

    // Update state indicators
    this.updateEffectiveState(effectId);
    this.updateControlStates(effectId);

    // Save to appropriate tier
    this.queueSave(effectId);

    if (notify) {
      ui.notifications.info(`Map Shine: ${effectId} reset to defaults`);
    }
  }

  /**
   * Generate a text dump of all effect parameters that differ from schema defaults
   * grouped by effect. Used for debugging and tuning default values.
   * @returns {string}
   * @public
   */
  generateNonDefaultSettingsDump() {
    const lines = [];

    const scene = canvas?.scene;
    const sceneName = scene?.name || 'Unknown Scene';
    const sceneId = scene?.id || 'unknown-id';

    lines.push('Map Shine Advanced - Non-Default Effect Settings');
    lines.push(`Scene: ${sceneName} (${sceneId})`);
    lines.push(`Settings Mode: ${this.settingsMode}`);
    lines.push(`User: ${game.user?.name || 'Unknown User'}`);
    lines.push(`Timestamp: ${new Date().toISOString()}`);
    lines.push('');

    let anyDifferences = false;

    for (const [effectId, effectData] of Object.entries(this.effectFolders)) {
      if (!effectData || !effectData.schema) continue;

      const params = effectData.params || {};
      const schemaParams = effectData.schema.parameters || {};

      const effectLines = [];

      // Enabled flag vs schema default
      const defaultEnabled = effectData.schema.enabled ?? true;
      const currentEnabled = (params.enabled === undefined) ? defaultEnabled : params.enabled;
      if (this.valuesDiffer(currentEnabled, defaultEnabled)) {
        effectLines.push(`enabled = ${JSON.stringify(currentEnabled)}`);
      }

      // Compare each declared parameter to its default. We intentionally
      // skip parameter-level `enabled` here because the effect-level
      // enabled state is already tracked and printed above, and including
      // both would produce duplicate `enabled` lines in the dump.
      for (const [paramId, paramDef] of Object.entries(schemaParams)) {
        if (paramId === 'enabled') continue;

        // Skip runtime/status-only fields and non-user-tunable params.
        // These can legitimately differ from defaults without indicating
        // a user-authored non-default setting.
        if (paramId === 'textureStatus') continue;
        if (paramDef?.readonly === true) continue;
        if (paramDef?.hidden === true) continue;

        const defaultValue = paramDef.default;
        const rawCurrentValue = params[paramId];
        const currentValue = (rawCurrentValue === undefined) ? defaultValue : rawCurrentValue;

        if (!this.valuesDiffer(currentValue, defaultValue, paramDef)) continue;

        const formatted = this.formatParamValue(paramId, currentValue, paramDef);
        effectLines.push(`${paramId} = ${formatted}`);
      }

      if (effectLines.length > 0) {
        anyDifferences = true;
        lines.push(`--- Effect: ${effectId} ---`);
        for (const l of effectLines) {
          lines.push(l);
        }
        lines.push('');
      }
    }

    if (!anyDifferences) {
      lines.push('All effects are currently at their schema default values.');
    }

    return lines.join('\n');
  }

  generateChangedSettingsDump() {
    const lines = [];

    const scene = canvas?.scene;
    const sceneName = scene?.name || 'Unknown Scene';
    const sceneId = scene?.id || 'unknown-id';

    lines.push('Map Shine Advanced - Changed Effect Settings');
    lines.push(`Scene: ${sceneName} (${sceneId})`);
    lines.push(`Settings Mode: ${this.settingsMode}`);
    lines.push(`User: ${game.user?.name || 'Unknown User'}`);
    lines.push(`Timestamp: ${new Date().toISOString()}`);
    lines.push('');

    const dirtyByEffect = new Map();
    for (const key of this.dirtyParams) {
      const [effectId, paramId] = String(key).split('.');
      if (!effectId || !paramId) continue;
      if (!dirtyByEffect.has(effectId)) dirtyByEffect.set(effectId, new Set());
      dirtyByEffect.get(effectId).add(paramId);
    }

    let anyDifferences = false;

    for (const [effectId, effectData] of Object.entries(this.effectFolders)) {
      if (!effectData || !effectData.schema) continue;

      const dirtySet = dirtyByEffect.get(effectId);
      if (!dirtySet || dirtySet.size === 0) continue;

      const params = effectData.params || {};
      const schemaParams = effectData.schema.parameters || {};

      const effectLines = [];

      const defaultEnabled = effectData.schema.enabled ?? true;
      const currentEnabled = (params.enabled === undefined) ? defaultEnabled : params.enabled;
      if (dirtySet.has('enabled') && this.valuesDiffer(currentEnabled, defaultEnabled)) {
        effectLines.push(`enabled = ${JSON.stringify(currentEnabled)}`);
      }

      for (const [paramId, paramDef] of Object.entries(schemaParams)) {
        if (paramId === 'enabled') continue;
        if (!dirtySet.has(paramId)) continue;

        const defaultValue = paramDef.default;
        const rawCurrentValue = params[paramId];
        const currentValue = (rawCurrentValue === undefined) ? defaultValue : rawCurrentValue;
        if (!this.valuesDiffer(currentValue, defaultValue, paramDef)) continue;

        const formatted = this.formatParamValue(paramId, currentValue, paramDef);
        effectLines.push(`${paramId} = ${formatted}`);
      }

      if (effectLines.length > 0) {
        anyDifferences = true;
        lines.push(`--- Effect: ${effectId} ---`);
        for (const l of effectLines) {
          lines.push(l);
        }
        lines.push('');
      }
    }

    if (!anyDifferences) {
      lines.push('No changed controls currently differ from schema defaults.');
    }

    return lines.join('\n');
  }

  /**
   * Format a parameter value for the non-default settings dump. Numbers
   * are rounded according to their slider step so we avoid extremely
   * long floating point representations.
   * @param {string} paramId
   * @param {any} value
   * @param {Object} [paramDef]
   * @returns {string}
   * @private
   */
  formatParamValue(paramId, value, paramDef) {
    if (typeof value !== 'number') {
      return JSON.stringify(value);
    }

    const step = (paramDef && typeof paramDef.step === 'number') ? paramDef.step : 0.01;

    // Derive a sensible number of decimals from the step size (e.g.
    // 0.01 -> 2 decimals, 0.005 -> 3 decimals, 1 -> 0 decimals).
    let decimals = 0;
    if (step < 1) {
      const log10 = Math.log10(step);
      decimals = Math.max(0, -Math.floor(log10));
      if (decimals > 6) decimals = 6; // hard cap for safety
    }

    let v = value;
    const tiny = step / 100;
    if (Math.abs(v) < tiny) v = 0;

    v = Number(v.toFixed(decimals));
    return JSON.stringify(v);
  }

  /**
   * Helper to compare parameter values (supports primitives and JSON-serializable objects)
   * @param {any} a
   * @param {any} b
   * @returns {boolean}
   * @private
   */
  valuesDiffer(a, b, paramDef) {
    // Fast path for strict equality and null/undefined cases
    if (a === b) return false;
    if (a == null || b == null) return a !== b;

    // Some persisted scene flags can deserialize numeric values as strings.
    // If the schema expects a numeric control, normalize numeric strings
    // before comparing so we don't report false non-default values.
    if (paramDef && (paramDef.type === 'slider' || paramDef.type === 'number')) {
      if (typeof a === 'string' && a.trim() !== '' && isFinite(Number(a))) a = Number(a);
      if (typeof b === 'string' && b.trim() !== '' && isFinite(Number(b))) b = Number(b);
    }

    // For numeric parameters, treat tiny floating point differences as
    // equal so that 0.7 and 0.7000000000000001 do not register as
    // non-default.
    if (typeof a === 'number' && typeof b === 'number') {
      if (!isFinite(a) || !isFinite(b)) return a !== b;

      // Snap/round to the control's step grid if available; otherwise
      // use the same default step as formatParamValue (0.01).
      const step = (paramDef && typeof paramDef.step === 'number' && paramDef.step > 0)
        ? paramDef.step
        : 0.01;

      let snappedA = a;
      let snappedB = b;
      if (step > 0) {
        snappedA = Math.round(a / step) * step;
        snappedB = Math.round(b / step) * step;
      }

      // Crush tiny near-zero values to 0 (avoid -0 and 1e-17 noise).
      const tiny = step / 100;
      if (Math.abs(snappedA) < tiny) snappedA = 0;
      if (Math.abs(snappedB) < tiny) snappedB = 0;

      let eps;
      eps = step / 10;
      return Math.abs(snappedA - snappedB) > eps;
    }

    // Fallback: deep compare via JSON
    return JSON.stringify(a) !== JSON.stringify(b);
  }

  /**
   * Copy the non-default settings dump to the clipboard, with a console fallback
   * @returns {Promise<void>}
   * @public
   */
  async copyNonDefaultSettingsToClipboard() {
    const dump = this.generateNonDefaultSettingsDump();

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(dump);
        ui.notifications.info('Map Shine: Non-default settings copied to clipboard');
      } else {
        throw new Error('Clipboard API not available');
      }
    } catch (error) {
      log.warn('Failed to copy non-default settings to clipboard, printing to console instead:', error);
      console.log(dump);
      ui.notifications.warn('Map Shine: Could not copy to clipboard. Dump printed to browser console.');
    }
  }

  /**
   * Copy the changed-this-session settings dump to the clipboard, with a console fallback
   * @returns {Promise<void>}
   * @public
   */
  async copyChangedSettingsToClipboard() {
    const dump = this.generateChangedSettingsDump();

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(dump);
        ui.notifications.info('Map Shine: Session changes copied to clipboard');
        this.dirtyParams.clear();
      } else {
        throw new Error('Clipboard API not available');
      }
    } catch (error) {
      log.warn('Failed to copy changed settings to clipboard, printing to console instead:', error);
      console.log(dump);
      ui.notifications.warn('Map Shine: Could not copy to clipboard. Dump printed to browser console.');
    }
  }

  generateCurrentSettingsDump() {
    const lines = [];

    const scene = canvas?.scene;
    const sceneName = scene?.name || 'Unknown Scene';
    const sceneId = scene?.id || 'unknown-id';

    lines.push('Map Shine Advanced - Current Effect Settings');
    lines.push(`Scene: ${sceneName} (${sceneId})`);
    lines.push(`Settings Mode: ${this.settingsMode}`);
    lines.push(`User: ${game.user?.name || 'Unknown User'}`);
    lines.push(`Timestamp: ${new Date().toISOString()}`);
    lines.push('');

    for (const [effectId, effectData] of Object.entries(this.effectFolders)) {
      if (!effectData || !effectData.schema) continue;

      const params = effectData.params || {};
      const schemaParams = effectData.schema.parameters || {};

      const effectLines = [];

      // Effect enabled state (not necessarily present as a schema parameter)
      const defaultEnabled = effectData.schema.enabled ?? true;
      const currentEnabled = params.enabled ?? defaultEnabled;
      effectLines.push(`enabled = ${JSON.stringify(currentEnabled)}`);

      for (const [paramId, paramDef] of Object.entries(schemaParams)) {
        if (paramId === 'enabled') continue;
        const currentValue = params[paramId];
        const formatted = this.formatParamValue(paramId, currentValue, paramDef);
        effectLines.push(`${paramId} = ${formatted}`);
      }

      lines.push(`--- Effect: ${effectId} ---`);
      for (const l of effectLines) {
        lines.push(l);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  async copyCurrentSettingsToClipboard() {
    const dump = this.generateCurrentSettingsDump();

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(dump);
        ui.notifications.info('Map Shine: Current settings copied to clipboard');
      } else {
        throw new Error('Clipboard API not available');
      }
    } catch (error) {
      log.warn('Failed to copy current settings to clipboard, printing to console instead:', error);
      console.log(dump);
      ui.notifications.warn('Map Shine: Could not copy to clipboard. Dump printed to browser console.');
    }
  }

  /**
   * Run sanity check on an effect's current parameters
   * Detects invalid parameter combinations and warns/auto-fixes
   * @param {string} effectId - Effect to check
   * @private
   */
  runSanityCheck(effectId) {
    if (this._uiValidatorActive) return;
    const effectData = this.effectFolders[effectId];
    if (!effectData) return;

    const validation = globalValidator.validateAllParameters(
      effectId,
      effectData.params,
      effectData.schema
    );

    if (!validation.valid) {
      log.error(`${effectId} sanity check failed:`, validation.errors);
      ui.notifications.warn(`Map Shine: ${effectId} has invalid settings`);
      
      // Apply fixes if available
      if (validation.params) {
        for (const [paramId, fixedValue] of Object.entries(validation.params)) {
          if (effectData.params[paramId] !== fixedValue) {
            log.info(`Auto-fixing ${effectId}.${paramId}: ${effectData.params[paramId]} -> ${fixedValue}`);
            effectData.params[paramId] = fixedValue;
            
            // Refresh UI
            if (effectData.bindings[paramId]) {
              effectData.bindings[paramId].refresh();
            }
            
            // Notify callback
            const callback = this.effectCallbacks.get(effectId);
            if (callback) {
              callback(effectId, paramId, fixedValue);
            }
          }
        }
        
        ui.notifications.info('Map Shine: Auto-fixes applied');
      }
    } else if (validation.warnings.length > 0) {
      // Show warning but don't block
      log.warn(`${effectId} sanity warnings:`, validation.warnings);
      
      // Only show notification for critical warnings
      const criticalWarnings = validation.warnings.filter(w => 
        w.includes('overflow') || w.includes('invalid') || w.includes('extreme')
      );
      if (criticalWarnings.length > 0) {
        ui.notifications.warn(`Map Shine: ${criticalWarnings[0]}`);
      }
    }
  }

  /**
   * Revert GM overrides back to Map Maker settings
   * @returns {Promise<void>}
   * @public
   */
  async revertToMapMaker() {
    try {
      const scene = canvas?.scene;
      if (!scene) {
        log.error('Cannot revert: no active scene');
        return;
      }

      if (!game.user.isGM) {
        log.error('Only GMs can revert settings');
        return;
      }

      // Clear GM tier
      const allSettings = scene.getFlag('map-shine-advanced', 'settings') || {};
      allSettings.gm = null;
      await scene.setFlag('map-shine-advanced', 'settings', allSettings);

      log.info('Reverted to Map Maker settings');

      // Reload all effects
      this.reloadAllEffectParameters();

      ui.notifications.info('Map Shine: Reverted to original settings');
    } catch (error) {
      log.error('Failed to revert settings:', error);
      ui.notifications.error('Map Shine: Failed to revert settings');
    }
  }

  /**
   * Add status indicator element to effect folder
   * Shows warnings when effect is enabled but ineffective
   * @param {string} effectId - Effect identifier
   * @param {Object} folder - Tweakpane folder
   * @private
   */
  addStatusIndicator(effectId, folder) {
    // Find the title element (button) in the folder
    // Tweakpane uses class 'tp-fldv_t' for the title button
    const titleElement = folder.element.querySelector('.tp-fldv_t');
    
    if (!titleElement) {
      return;
    }

    // Create status light
    const statusLight = document.createElement('div');
    statusLight.className = 'status-light';
    statusLight.style.width = '8px';
    statusLight.style.height = '8px';
    statusLight.style.borderRadius = '50%';
    statusLight.style.backgroundColor = '#666';
    statusLight.style.marginRight = '8px';
    statusLight.style.display = 'inline-block';
    statusLight.style.verticalAlign = 'middle';
    statusLight.style.flexShrink = '0';
    statusLight.style.transition = 'background-color 0.2s, box-shadow 0.2s';
    
    // Add tooltop
    statusLight.title = 'Status: Initializing...';
    
    // Insert before the title text (first child of button)
    titleElement.insertBefore(statusLight, titleElement.firstChild);
    
    // Store reference to the light element itself
    this.effectFolders[effectId].statusElement = statusLight;
  }

  /**
   * Update effective state indicator for an effect
   * @param {string} effectId - Effect identifier
   * @private
   */
  updateEffectiveState(effectId) {
    const effectData = this.effectFolders[effectId];
    if (!effectData || !effectData.statusElement) return;
    
    // Get effective state based on effect type
    let effectiveState;
    if (effectId === 'specular') {
      effectiveState = getSpecularEffectiveState(effectData.params);
    } else {
      // Generic fallback - check if enabled
      effectiveState = {
        effective: effectData.params.enabled !== false,
        reasons: effectData.params.enabled === false ? ['Effect is disabled'] : []
      };
    }
    
    // Update status light
    const statusLight = effectData.statusElement;
    let tooltip = '';
    
    if (!effectData.params.enabled) {
      // Disabled
      statusLight.style.backgroundColor = '#666666'; // Grey
      statusLight.style.boxShadow = 'none';
      tooltip = 'Disabled';
    } else if (!effectiveState.effective) {
      // Enabled but ineffective (Error/Warning)
      statusLight.style.backgroundColor = '#ff4444'; // Red
      statusLight.style.boxShadow = '0 0 4px #ff4444';
      tooltip = effectiveState.reasons.join('; ');
    } else {
      // Active & Effective
      statusLight.style.backgroundColor = '#44ff44'; // Green
      statusLight.style.boxShadow = '0 0 4px #44ff44';
      tooltip = 'Active';
    }
    
    statusLight.title = `Status: ${tooltip}`;
  }

  /**
   * Update control enabled/disabled states based on dependencies
   * @param {string} effectId - Effect identifier
   * @private
   */
  updateControlStates(effectId) {
    const effectData = this.effectFolders[effectId];
    if (!effectData || !effectData.bindingConfigs) return;
    
    // Get dependency state based on effect type
    let depState;
    if (effectId === 'specular') {
      depState = getStripeDependencyState(effectData.params);
    } else if (effectId === 'weather') {
      depState = {
        dynamicEnabled: effectData.params.dynamicEnabled === true,
        isGM: game.user.isGM
      };
    } else {
      return; // No dependencies for other effects yet
    }
    
    // Update each binding's disabled state
    for (const [paramId, config] of Object.entries(effectData.bindingConfigs)) {
      const { binding, paramDef } = config;
      
      // Determine if this control should be disabled
      let shouldDisable = false;
      let isProblemControl = false;
      let lockReason = '';

      if (effectId === 'weather') {
        // When Dynamic Weather is enabled, manual weather overrides become read-only.
        // (We keep other controls like time-of-day, variability, and dynamic settings interactive.)
        const manualParams = new Set([
          'precipitation',
          'cloudCover',
          'windSpeed',
          'windDirection',
          'freezeLevel',
          'fogDensity'
        ]);

        if (depState.dynamicEnabled && manualParams.has(paramId)) {
          shouldDisable = true;
          lockReason = 'Driven by Dynamic Weather';
        }

        // Respect schema-level readonly even if dynamic mode is off.
        if (paramDef?.readonly) {
          shouldDisable = true;
          if (!lockReason) lockReason = 'Read only';
        }

        if (paramDef?.gmOnly === true && depState.isGM !== true) {
          shouldDisable = true;
          if (!lockReason) lockReason = 'GM only';
        }
      }
      
      // Stripe blend mode and parallax - disabled if stripes off
      if ((paramId === 'stripeBlendMode' || paramId === 'parallaxStrength') && !depState.stripeControlsActive) {
        shouldDisable = true;
      }
      
      // Layer 1 controls
      if (paramId.startsWith('stripe1') && paramId !== 'stripe1Enabled') {
        if (!depState.stripe1Active) {
          // Layer disabled - check if this is the problem control
          if (depState.stripe1Problems && depState.stripe1Problems.includes(paramId)) {
            isProblemControl = true;
            shouldDisable = false; // Keep problem control enabled
          } else {
            shouldDisable = true; // Disable non-problem controls
          }
        }
      }
      
      // Layer 2 controls
      if (paramId.startsWith('stripe2') && paramId !== 'stripe2Enabled') {
        if (!depState.stripe2Active) {
          if (depState.stripe2Problems && depState.stripe2Problems.includes(paramId)) {
            isProblemControl = true;
            shouldDisable = false;
          } else {
            shouldDisable = true;
          }
        }
      }
      
      // Layer 3 controls
      if (paramId.startsWith('stripe3') && paramId !== 'stripe3Enabled') {
        if (!depState.stripe3Active) {
          if (depState.stripe3Problems && depState.stripe3Problems.includes(paramId)) {
            isProblemControl = true;
            shouldDisable = false;
          } else {
            shouldDisable = true;
          }
        }
      }
      
      // Apply disabled state
      binding.disabled = shouldDisable;
      
      // Apply red warning to problem controls
      const label = binding.controller.view.labelElement;
      if (label) {
        if (isProblemControl) {
          label.style.color = '#ff4444'; // Red warning
        } else {
          label.style.color = ''; // Reset to default
        }

        if (effectId === 'weather') {
          label.title = lockReason || '';
        }
      }
    }
  }

  /**
   * Auto-toggle layer enable states based on problematic values
   * Automatically disables layer when intensity/width = 0
   * Automatically re-enables when user fixes the problem
   * @param {string} effectId - Effect identifier
   * @param {string} paramId - Parameter that changed
   * @param {*} value - New value
   * @private
   */
  autoToggleLayerStates(effectId, paramId, value) {
    if (effectId !== 'specular') return; // Only for specular effect currently
    
    const effectData = this.effectFolders[effectId];
    if (!effectData) return;
    
    // Check if this is an intensity or width parameter
    const layerMatch = paramId.match(/^(stripe[123])(Intensity|Width)$/);
    if (!layerMatch) return;
    
    const layerPrefix = layerMatch[1]; // stripe1, stripe2, or stripe3
    const paramType = layerMatch[2];   // Intensity or Width
    const enableParam = `${layerPrefix}Enabled`;
    
    // Get the other critical parameter (if intensity changed, check width, and vice versa)
    const otherParam = paramType === 'Intensity' ? `${layerPrefix}Width` : `${layerPrefix}Intensity`;
    const otherValue = effectData.params[otherParam];
    
    // Determine if layer should be enabled
    // Enabled if BOTH intensity > 0 AND width > 0
    const shouldBeEnabled = value > 0 && otherValue > 0;
    
    // Get current enabled state
    const currentlyEnabled = effectData.params[enableParam];
    
    // Only update if state should change
    if (shouldBeEnabled && !currentlyEnabled) {
      // Re-enable layer (user fixed the problem)
      log.info(`Auto-enabling ${layerPrefix} (${paramId} is now ${value})`);
      effectData.params[enableParam] = true;
      
      // Update UI binding
      if (effectData.bindings[enableParam]) {
        effectData.bindings[enableParam].refresh();
      }
      
      // Notify callback
      const callback = this.effectCallbacks.get(effectId);
      if (callback) {
        callback(effectId, enableParam, true);
      }
    } else if (!shouldBeEnabled && currentlyEnabled) {
      // Disable layer (problem detected)
      log.info(`Auto-disabling ${layerPrefix} (${paramId} is ${value})`);
      effectData.params[enableParam] = false;
      
      // Update UI binding
      if (effectData.bindings[enableParam]) {
        effectData.bindings[enableParam].refresh();
      }
      
      // Notify callback
      const callback = this.effectCallbacks.get(effectId);
      if (callback) {
        callback(effectId, enableParam, false);
      }
    }
  }

  /**
   * Mark a parameter as dirty for batching
   * @private
   */
  markDirty(effectId, paramId) {
    this.dirtyParams.add(`${effectId}.${paramId}`);
  }

  /**
   * Start the decoupled UI update loop
   * @private
   */
  startUILoop() {
    if (this.running) {
      log.warn('UI loop already running');
      return;
    }

    this.running = true;
    log.info(`Starting UI loop at ${this.uiFrameRate} Hz`);

    const uiLoop = async () => {
      // Early exit if stopped
      if (!this.running) {
        this.rafHandle = null;
        return;
      }

      // Skip frame if not visible
      if (!this.visible) {
        this.rafHandle = requestAnimationFrame(uiLoop);
        return;
      }

      const now = performance.now();
      const delta = now - this.lastUIFrame;

      // Throttle to target frame rate
      if (delta < 1000 / this.uiFrameRate) {
        this.rafHandle = requestAnimationFrame(uiLoop);
        return;
      }

      // Measure frame time
      const frameStart = performance.now();

      this.lastUIFrame = now;

      // Process dirty parameters (if any)
      if (this.dirtyParams.size > 0) {
        this.dirtyParams.clear(); // Clear for next frame
      }

      // Flush save queue (batched saves)
      await this.flushSaveQueue();

      // Measure performance
      const frameTime = performance.now() - frameStart;
      this.perf.lastFrameTime = frameTime;
      this.perf.avgFrameTime = (this.perf.avgFrameTime * this.perf.frameCount + frameTime) / (this.perf.frameCount + 1);
      this.perf.frameCount++;

      // Warn if exceeding budget
      if (frameTime > 2.0) {
        this.perf.warningCount++;
        if (this.perf.warningCount >= 3) {
          log.warn(`UI frame time exceeded budget: ${frameTime.toFixed(2)}ms (target: <2ms)`);
          this.perf.warningCount = 0; // Reset after warning
        }
      } else {
        this.perf.warningCount = 0;
      }

      // Dynamic Exposure debug monitoring (read-only fields)
      try {
        const dem = window.MapShine?.dynamicExposureManager;
        const src = dem?.debugState;
        const dst = this.globalParams?.dynamicExposureDebug;
        if (src && dst) {
          dst.subjectTokenId = String(src.subjectTokenId ?? '');
          dst.measuredLuma = Number.isFinite(src.measuredLuma) ? src.measuredLuma : 0.0;
          dst.outdoors = Number.isFinite(src.outdoors) ? src.outdoors : 0.0;
          dst.targetExposure = Number.isFinite(src.targetExposure) ? src.targetExposure : 1.0;
          dst.appliedExposure = Number.isFinite(src.appliedExposure) ? src.appliedExposure : 1.0;
          dst.screenU = Number.isFinite(src.screenU) ? src.screenU : 0.0;
          dst.screenV = Number.isFinite(src.screenV) ? src.screenV : 0.0;
          dst.lastProbeAgeSeconds = Number.isFinite(src.lastProbeAgeSeconds) ? src.lastProbeAgeSeconds : 0.0;

          const bindings = this._dynamicExposureDebugBindings;
          if (Array.isArray(bindings)) {
            for (const b of bindings) {
              try {
                b?.refresh?.();
              } catch (_) {
              }
            }
          }
        }
      } catch (_) {
      }

      // Continue loop
      this.rafHandle = requestAnimationFrame(uiLoop);
    };

    this.rafHandle = requestAnimationFrame(uiLoop);
  }

  /**
   * Stop the UI update loop
   */
  stopUILoop() {
    this.running = false;
    if (this.rafHandle) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    log.info('UI loop stopped');
  }

  /**
   * Update UI scale
   * @private
   */
  updateScale() {
    if (this.container) {
      this.container.style.transformOrigin = 'top left';
      this.container.style.transform = `scale(${this.uiScale})`;
    }
  }

  /**
   * Make the pane draggable
   * @private
   */
  makeDraggable() {
    // Prefer the custom header overlay if present, otherwise fall back to the pane element or container
    const dragHandle = this.headerOverlay || this.pane?.element || this.container;
    if (!dragHandle) {
      log.warn('Could not find drag handle element for Tweakpane UI');
      return;
    }

    let isDragging = false;
    let hasDragged = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    dragHandle.style.cursor = 'move';

    const onMouseDown = (e) => {
      isDragging = true;
      hasDragged = false;
      startX = e.clientX;
      startY = e.clientY;
      
      const rect = this.container.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      // Clear any right/bottom anchoring so left/top take effect
      this.container.style.right = 'auto';
      this.container.style.bottom = 'auto';
      this.container.style.left = `${startLeft}px`;
      this.container.style.top = `${startTop}px`;

      // Use capture phase so drag tracking is not blocked by UI-level stopPropagation.
      document.addEventListener('mousemove', onMouseMove, { capture: true });
      document.addEventListener('mouseup', onMouseUp, { capture: true });
      e.preventDefault();
      e.stopPropagation();
    };

    const onMouseMove = (e) => {
      if (!isDragging) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      // Treat movement beyond a small threshold as a drag
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        hasDragged = true;
      }

      this.container.style.left = `${startLeft + dx}px`;
      this.container.style.top = `${startTop + dy}px`;
      this.container.style.right = 'auto';
      this.container.style.bottom = 'auto';
    };

    const onMouseUp = (e) => {
      isDragging = false;
      document.removeEventListener('mousemove', onMouseMove, { capture: true });
      document.removeEventListener('mouseup', onMouseUp, { capture: true });
      
      // If we actually dragged, suppress the click that would fold the pane
      if (hasDragged && e) {
        e.preventDefault();
        e.stopPropagation();
      } else {
        // No drag: allow normal Tweakpane behavior (click-to-fold)
      }

      // Save position after drag or click
      this.saveUIState();
    };

    dragHandle.addEventListener('mousedown', onMouseDown);

    // Disable default Tweakpane click-to-fold on the header; folding is handled by our custom [-] button
    dragHandle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }

  /**
   * Load UI state from client settings
   * @private
   */
  async loadUIState() {
    try {
      const state = game.settings.get('map-shine-advanced', 'ui-state') || {};
      
      // Restore position
      if (state.position) {
        this.container.style.left = state.position.left || 'auto';
        this.container.style.top = state.position.top || 'auto';
        this.container.style.right = state.position.right || '20px';
        this.container.style.bottom = state.position.bottom || '20px';
      } else {
        // Default position: bottom-right
        this.container.style.right = '20px';
        this.container.style.bottom = '20px';
      }

      // Restore accordion states
      if (state.accordionStates) {
        this.accordionStates = state.accordionStates;
      }

      // Restore global params
      if (state.globalParams) {
        // NOTE: state.globalParams is persisted across versions.
        // We must merge nested objects defensively so newly added parameters
        // (like tokenColorCorrection.windowLightIntensity) don't disappear.
        const { tokenColorCorrection, dynamicExposure, ...rest } = state.globalParams;
        Object.assign(this.globalParams, rest);
        if (tokenColorCorrection && typeof tokenColorCorrection === 'object') {
          if (!this.globalParams.tokenColorCorrection) this.globalParams.tokenColorCorrection = {};
          Object.assign(this.globalParams.tokenColorCorrection, tokenColorCorrection);
        }

        if (dynamicExposure && typeof dynamicExposure === 'object') {
          if (!this.globalParams.dynamicExposure) this.globalParams.dynamicExposure = {};
          Object.assign(this.globalParams.dynamicExposure, dynamicExposure);
        }

        // Backwards-compatible defaults for newly added token controls
        if (this.globalParams.tokenColorCorrection) {
          if (this.globalParams.tokenColorCorrection.windowLightIntensity === undefined) {
            this.globalParams.tokenColorCorrection.windowLightIntensity = 1.0;
          }
        }

        // Backwards-compatible default for sunLatitude (added as global param)
        if (this.globalParams.sunLatitude === undefined) {
          this.globalParams.sunLatitude = 0.1;
        }

        // Backwards-compatible defaults for newly added Dynamic Exposure controls
        if (this.globalParams.dynamicExposure) {
          if (this.globalParams.dynamicExposure.enabled === undefined) this.globalParams.dynamicExposure.enabled = true;
          if (this.globalParams.dynamicExposure.minExposure === undefined) this.globalParams.dynamicExposure.minExposure = 0.5;
          if (this.globalParams.dynamicExposure.maxExposure === undefined) this.globalParams.dynamicExposure.maxExposure = 2.5;
          if (this.globalParams.dynamicExposure.probeHz === undefined) this.globalParams.dynamicExposure.probeHz = 8;
          if (this.globalParams.dynamicExposure.tauBrighten === undefined) this.globalParams.dynamicExposure.tauBrighten = 15.0;
          if (this.globalParams.dynamicExposure.tauDarken === undefined) this.globalParams.dynamicExposure.tauDarken = 15.0;
        }
      }

      // Restore scale
      if (state.scale) {
        this.uiScale = state.scale;
        this.updateScale();
      }

      log.debug('UI state loaded from settings');
    } catch (e) {
      log.warn('Failed to load UI state:', e);
      // Use defaults
      this.container.style.right = '20px';
      this.container.style.bottom = '20px';
    }
  }

  /**
   * Save UI state to client settings (debounced to prevent freeze on rapid accordion clicks)
   * @private
   */
  saveUIState() {
    if (this._uiValidatorActive) return;
    // PERFORMANCE: Debounce saves to prevent freezing when rapidly clicking accordions
    // Each accordion fold event was triggering an immediate async database write
    if (this._uiStateSaveTimeout) {
      clearTimeout(this._uiStateSaveTimeout);
    }
    
    this._uiStateSaveTimeout = setTimeout(() => {
      this._uiStateSaveTimeout = null;
      this._doSaveUIState();
    }, 500); // 500ms debounce
  }

  /**
   * Actually perform the UI state save
   * @private
   */
  async _doSaveUIState() {
    try {
      const state = {
        position: {
          left: this.container.style.left,
          top: this.container.style.top,
          right: this.container.style.right,
          bottom: this.container.style.bottom
        },
        accordionStates: this.accordionStates,
        globalParams: this.globalParams,
        scale: this.uiScale
      };

      await game.settings.set('map-shine-advanced', 'ui-state', state);
      log.debug('UI state saved to settings');
    } catch (e) {
      log.warn('Failed to save UI state:', e);
    }
  }

  /**
   * Throttle a function
   * @private
   */
  throttle(func, wait) {
    let timeout = null;
    let lastArgs = null;

    return function(...args) {
      lastArgs = args;

      if (!timeout) {
        timeout = setTimeout(() => {
          func.apply(this, lastArgs);
          timeout = null;
        }, wait);
      }
    };
  }

  /**
   * Show the panel
   */
  show() {
    if (this.container) {
      this.container.style.display = 'block';
      this.visible = true;
    }
  }

  /**
   * Hide the panel
   */
  hide() {
    if (this.container) {
      this.container.style.display = 'none';
      this.visible = false;
    }
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
   * Dispose of the UI
   */
  dispose() {
    log.info('Disposing Tweakpane UI');
    
    this.stopUILoop();
    
    if (this.pane) {
      this.pane.dispose();
      this.pane = null;
    }
    
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
    
    this.effectFolders = {};
    this.effectCallbacks.clear();
    this.dirtyParams.clear();
  }

  async runUIValidator() {
    if (this._uiValidatorRunning) return;

    const validatorButton = this._uiValidatorButton;
    if (validatorButton) validatorButton.disabled = true;

    this._uiValidatorRunning = true;
    this._uiValidatorActive = true;

    const savedQueue = Array.from(this.saveQueue);
    this.saveQueue.clear();

    const originalGlobals = {
      mapMakerMode: this.globalParams.mapMakerMode,
      timeRate: this.globalParams.timeRate
    };

    const originalUiScale = this.uiScale;
    const originalUiScaleBinding = this.uiScaleParams.scale;

    const originalEffects = {};
    for (const [effectId, effectData] of Object.entries(this.effectFolders)) {
      if (!effectData?.params) continue;
      originalEffects[effectId] = { ...effectData.params };
    }

    /** @type {Array<{kind:string,effectId?:string,paramId:string,status:'PASS'|'FAIL'|'SKIP',error?:any}>} */
    const results = [];

    const jiggleNumber = (value, min, max, step) => {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return { ok: false, value: value };
      const span = (Number.isFinite(max) ? max : n + 1) - (Number.isFinite(min) ? min : n - 1);
      const baseStep = typeof step === 'number' && step > 0 ? step : (Number.isFinite(span) && span > 0 ? span / 20 : 1);
      let next = n + baseStep;
      if (Number.isFinite(max) && next > max) next = n - baseStep;
      if (Number.isFinite(min) && next < min) next = min;
      if (Number.isFinite(max) && next > max) next = max;
      if (Object.is(next, n)) {
        if (Number.isFinite(min) && !Object.is(min, n)) next = min;
        else if (Number.isFinite(max) && !Object.is(max, n)) next = max;
      }
      return { ok: true, value: next };
    };

    const jiggleOption = (current, options) => {
      if (!options) return { ok: false, value: current };
      const values = Object.values(options);
      if (values.length <= 1) return { ok: false, value: current };
      const idx = values.findIndex(v => v === current);
      const next = values[(idx + 1) % values.length];
      return { ok: true, value: next };
    };

    const quantizeToStep = (value, step, min) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return value;
      if (typeof step !== 'number' || !Number.isFinite(step) || step <= 0) return value;
      const base = (typeof min === 'number' && Number.isFinite(min)) ? min : 0;
      const q = Math.round((value - base) / step) * step + base;
      // Avoid -0
      return Object.is(q, -0) ? 0 : q;
    };

    const safeInvoke = async (fn, ev) => {
      const ret = fn(ev);
      await Promise.resolve(ret);
    };

    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

    try {
      const globalTests = [
        { id: 'timeRate', min: 0, max: 200, step: 1 },
        { id: 'uiScale', min: 0.5, max: 2.0, step: 0.1 }
      ];

      for (const t of globalTests) {
        const handler = this._uiValidatorGlobalHandlers[t.id];
        if (!handler) {
          results.push({ kind: 'global', paramId: t.id, status: 'FAIL', error: 'Missing handler' });
          continue;
        }

        try {
          if (t.id === 'uiScale') {
            const jig = jiggleNumber(this.uiScaleParams.scale, t.min, t.max, t.step);
            if (!jig.ok) {
              results.push({ kind: 'global', paramId: t.id, status: 'SKIP', error: 'Non-numeric' });
              continue;
            }
            await safeInvoke(handler, { value: jig.value, last: false });
            await safeInvoke(handler, { value: originalUiScaleBinding, last: false });
            results.push({ kind: 'global', paramId: t.id, status: 'PASS' });
          } else {
            const cur = this.globalParams[t.id];
            const jig = jiggleNumber(cur, t.min, t.max, t.step);
            if (!jig.ok) {
              results.push({ kind: 'global', paramId: t.id, status: 'SKIP', error: 'Non-numeric' });
              continue;
            }
            await safeInvoke(handler, { value: jig.value, last: true });

            // Basic runtime assertion: timeRate should affect TimeManager scale.
            if (t.id === 'timeRate') {
              const tm = window.MapShine?.timeManager;
              const expectedScale = jig.value / 100;
              const scale = tm?.scale;
              if (typeof scale === 'number' && Number.isFinite(scale)) {
                const eps = 0.0001;
                if (Math.abs(scale - expectedScale) > eps) {
                  results.push({ kind: 'assert', paramId: 'timeRate.scale', status: 'FAIL', error: `TimeManager.scale=${scale} expected≈${expectedScale}` });
                } else {
                  results.push({ kind: 'assert', paramId: 'timeRate.scale', status: 'PASS' });
                }
              } else {
                results.push({ kind: 'assert', paramId: 'timeRate.scale', status: 'SKIP', error: 'TimeManager.scale not readable' });
              }
            }

            await safeInvoke(handler, { value: originalGlobals[t.id], last: true });
            results.push({ kind: 'global', paramId: t.id, status: 'PASS' });
          }
        } catch (e) {
          results.push({ kind: 'global', paramId: t.id, status: 'FAIL', error: e });
        }
      }

      for (const [effectId, effectData] of Object.entries(this.effectFolders)) {
        const handlers = effectData?._uiValidatorHandlers;
        const bindingConfigs = effectData?.bindingConfigs;
        if (!handlers || !bindingConfigs) continue;

        for (const [paramId, cfg] of Object.entries(bindingConfigs)) {
          const binding = cfg?.binding;
          const paramDef = cfg?.paramDef;

          if (!binding || !paramDef) continue;
          if (paramDef.readonly) {
            results.push({ kind: 'effect', effectId, paramId, status: 'SKIP', error: 'readonly' });
            continue;
          }
          if (binding.disabled) {
            results.push({ kind: 'effect', effectId, paramId, status: 'SKIP', error: 'disabled' });
            continue;
          }

          const handler = handlers[paramId];
          if (!handler) {
            results.push({ kind: 'effect', effectId, paramId, status: 'FAIL', error: 'Missing handler' });
            continue;
          }

          const original = originalEffects[effectId]?.[paramId];
          const current = effectData.params[paramId];
          let nextValue = null;
          let ok = true;

          if (paramDef.options) {
            const jig = jiggleOption(current, paramDef.options);
            ok = jig.ok;
            nextValue = jig.value;
          } else if (typeof current === 'boolean') {
            nextValue = !current;
          } else if (typeof current === 'number' || typeof paramDef.min === 'number' || typeof paramDef.max === 'number') {
            const jig = jiggleNumber(
              typeof current === 'number' ? current : (typeof original === 'number' ? original : 0),
              paramDef.min,
              paramDef.max,
              paramDef.step
            );
            ok = jig.ok;
            nextValue = jig.value;
          } else {
            results.push({ kind: 'effect', effectId, paramId, status: 'SKIP', error: 'Unsupported type' });
            continue;
          }

          if (!ok || nextValue === null || nextValue === undefined) {
            results.push({ kind: 'effect', effectId, paramId, status: 'SKIP', error: 'No jiggle value' });
            continue;
          }

          try {
            await safeInvoke(handler, { value: nextValue, last: true });

            // Sanity assertion: if a runtime effect exists and it exposes this param,
            // verify that it actually changed (catches disconnected updateCallbacks).
            try {
              const composer = window.MapShine?.effectComposer;
              const runtimeEffect = composer?.effects?.get?.(effectId);
              if (runtimeEffect) {
                if (paramId === 'enabled') {
                  const hasParamsEnabled = runtimeEffect.params && Object.prototype.hasOwnProperty.call(runtimeEffect.params, 'enabled');
                  const actual = hasParamsEnabled ? runtimeEffect.params.enabled : runtimeEffect.enabled;
                  if (actual !== nextValue) {
                    results.push({ kind: 'assert', effectId, paramId: `${effectId}.enabled`, status: 'FAIL', error: `Runtime enabled=${actual} expected=${nextValue}` });
                  } else {
                    results.push({ kind: 'assert', effectId, paramId: `${effectId}.enabled`, status: 'PASS' });
                  }
                } else if (runtimeEffect.params && Object.prototype.hasOwnProperty.call(runtimeEffect.params, paramId)) {
                  const actual = runtimeEffect.params[paramId];
                  // If the control has a step, Tweakpane may snap/quantize the value.
                  // Compare against the step-quantized expected value to avoid false failures.
                  if (typeof actual === 'number' && typeof nextValue === 'number' && typeof paramDef.step === 'number') {
                    const expected = quantizeToStep(nextValue, paramDef.step, paramDef.min);
                    const eps = Math.max(1e-6, paramDef.step / 100);
                    if (Math.abs(actual - expected) > eps) {
                      results.push({ kind: 'assert', effectId, paramId: `${effectId}.${paramId}`, status: 'FAIL', error: `Runtime=${actual} expected≈${expected}` });
                    } else {
                      results.push({ kind: 'assert', effectId, paramId: `${effectId}.${paramId}`, status: 'PASS' });
                    }
                  } else if (actual !== nextValue) {
                    results.push({ kind: 'assert', effectId, paramId: `${effectId}.${paramId}`, status: 'FAIL', error: `Runtime=${actual} expected=${nextValue}` });
                  } else {
                    results.push({ kind: 'assert', effectId, paramId: `${effectId}.${paramId}`, status: 'PASS' });
                  }
                }
              }
            } catch (e) {
              results.push({ kind: 'assert', effectId, paramId: `${effectId}.${paramId}`, status: 'FAIL', error: e });
            }

            await safeInvoke(handler, { value: original, last: true });
            results.push({ kind: 'effect', effectId, paramId, status: 'PASS' });
          } catch (e) {
            results.push({ kind: 'effect', effectId, paramId, status: 'FAIL', error: e });
          }
        }
      }

      // Targeted assertion: Water enabled should actually enable/disable the Water effect.
      // This catches wiring issues where the UI toggles a flag but the visual output persists.
      try {
        const waterHandler = this.effectFolders?.water?._uiValidatorHandlers?.enabled;
        const originalWaterEnabled = originalEffects?.water?.enabled;
        const waterEffect = window.MapShine?.effectComposer?.effects?.get?.('water');

        if (!waterHandler || originalWaterEnabled === undefined) {
          results.push({ kind: 'assert', paramId: 'water.enabled', status: 'SKIP', error: 'Water not registered' });
        } else if (!waterEffect) {
          results.push({ kind: 'assert', paramId: 'water.enabled', status: 'SKIP', error: 'Water effect not available' });
        } else {
          const maskTex = (typeof waterEffect.getWaterMaskTexture === 'function')
            ? waterEffect.getWaterMaskTexture()
            : waterEffect.waterMask;
          if (!maskTex) {
            results.push({ kind: 'assert', paramId: 'water.enabled', status: 'SKIP', error: 'No water mask' });
            return;
          }

          await safeInvoke(waterHandler, { value: false, last: true });
          await nextFrame();
          await nextFrame();

          const okOff = waterEffect.enabled === false;
          if (!okOff) {
            results.push({ kind: 'assert', paramId: 'water.enabled', status: 'FAIL', error: 'Water effect still enabled after disabling water' });
          } else {
            results.push({ kind: 'assert', paramId: 'water.enabled', status: 'PASS' });
          }

          await safeInvoke(waterHandler, { value: originalWaterEnabled, last: true });
          await nextFrame();
        }
      } catch (e) {
        results.push({ kind: 'assert', paramId: 'water.enabled', status: 'FAIL', error: e });
      }

      try {
        const report = window.MapShine?.surfaceRegistry?.refresh?.() || window.MapShine?.surfaceReport;
        const scene = canvas?.scene;
        const tileManager = window.MapShine?.tileManager;

        if (!report || !scene || !tileManager) {
          results.push({ kind: 'surface', paramId: 'surfaceReport', status: 'SKIP', error: 'SurfaceRegistry/scene/tileManager not available' });
        } else {
          const fgElev = Number.isFinite(scene?.foregroundElevation) ? scene.foregroundElevation : 0;
          const layerEnabled = (sprite, layer) => {
            const mask = sprite?.layers?.mask;
            if (typeof mask !== 'number') return false;
            const bit = 1 << layer;
            return (mask & bit) !== 0;
          };

          const ROOF_LAYER = 20;
          const WEATHER_ROOF_LAYER = 21;
          const WATER_OCCLUDER_LAYER = 22;

          const surfaces = Array.isArray(report?.surfaces) ? report.surfaces : [];
          const bg = surfaces.find((s) => s?.surfaceId === 'scene:background');
          if (!bg) {
            results.push({ kind: 'surface', paramId: 'scene:background', status: 'FAIL', error: 'Missing background surface' });
          } else {
            if (bg.kind !== 'ground' || bg.stackId !== 'ground') {
              results.push({ kind: 'surface', effectId: 'scene:background', paramId: 'taxonomy', status: 'FAIL', error: `kind=${bg.kind} stackId=${bg.stackId}` });
            } else {
              results.push({ kind: 'surface', effectId: 'scene:background', paramId: 'taxonomy', status: 'PASS' });
            }
          }

          for (const s of surfaces) {
            if (!s || s.source !== 'tile') continue;
            const tileId = s.surfaceId;
            if (!tileId) continue;

            const tileDoc = scene.tiles?.get?.(tileId);
            if (!tileDoc) {
              results.push({ kind: 'surface', effectId: tileId, paramId: 'tileDoc', status: 'FAIL', error: 'TileDocument not found' });
              continue;
            }

            const elev = Number.isFinite(tileDoc?.elevation) ? tileDoc.elevation : 0;
            const expectedOverhead = elev >= fgElev;
            const roofFlag = tileDoc?.getFlag?.('map-shine-advanced', 'overheadIsRoof') ?? tileDoc?.flags?.['map-shine-advanced']?.overheadIsRoof;
            const expectedWeatherRoof = expectedOverhead && !!roofFlag;

            const expectedKind = expectedWeatherRoof ? 'roof' : (expectedOverhead ? 'overhead' : 'ground');
            const expectedStackId = expectedKind;

            if (s.kind !== expectedKind || s.stackId !== expectedStackId) {
              results.push({ kind: 'surface', effectId: tileId, paramId: 'taxonomy', status: 'FAIL', error: `report kind=${s.kind} stackId=${s.stackId} expected kind=${expectedKind} stackId=${expectedStackId}` });
            } else {
              results.push({ kind: 'surface', effectId: tileId, paramId: 'taxonomy', status: 'PASS' });
            }

            const spriteData = tileManager.tileSprites?.get?.(tileId);
            const sprite = spriteData?.sprite;
            if (!sprite) {
              results.push({ kind: 'surface', effectId: tileId, paramId: 'three.sprite', status: 'FAIL', error: 'Missing Three sprite for tile' });
              continue;
            }

            const bypassFlag = tileDoc?.getFlag?.('map-shine-advanced', 'bypassEffects')
              ?? tileDoc?.flags?.['map-shine-advanced']?.bypassEffects;
            const bypassEffects = !!bypassFlag;

            if (!!sprite.userData?.isOverhead !== expectedOverhead) {
              results.push({ kind: 'surface', effectId: tileId, paramId: 'three.userData.isOverhead', status: 'FAIL', error: `sprite=${!!sprite.userData?.isOverhead} expected=${expectedOverhead}` });
            }

            if (!!sprite.userData?.isWeatherRoof !== expectedWeatherRoof) {
              results.push({ kind: 'surface', effectId: tileId, paramId: 'three.userData.isWeatherRoof', status: 'FAIL', error: `sprite=${!!sprite.userData?.isWeatherRoof} expected=${expectedWeatherRoof}` });
            }

            if (bypassEffects) {
              if (!layerEnabled(sprite, OVERLAY_THREE_LAYER)) {
                results.push({ kind: 'surface', effectId: tileId, paramId: 'layers.overlay', status: 'FAIL', error: `Expected OVERLAY_THREE_LAYER=${OVERLAY_THREE_LAYER}` });
              }
              continue;
            }

            if (expectedOverhead !== layerEnabled(sprite, ROOF_LAYER)) {
              results.push({ kind: 'surface', effectId: tileId, paramId: 'layers.roof', status: 'FAIL', error: `ROOF_LAYER=${ROOF_LAYER} enabled=${layerEnabled(sprite, ROOF_LAYER)} expected=${expectedOverhead}` });
            }

            if (expectedWeatherRoof !== layerEnabled(sprite, WEATHER_ROOF_LAYER)) {
              results.push({ kind: 'surface', effectId: tileId, paramId: 'layers.weatherRoof', status: 'FAIL', error: `WEATHER_ROOF_LAYER=${WEATHER_ROOF_LAYER} enabled=${layerEnabled(sprite, WEATHER_ROOF_LAYER)} expected=${expectedWeatherRoof}` });
            }

            const cloudShadowsFlag = tileDoc?.getFlag?.('map-shine-advanced', 'cloudShadowsEnabled')
              ?? tileDoc?.flags?.['map-shine-advanced']?.cloudShadowsEnabled;
            const cloudTopsFlag = tileDoc?.getFlag?.('map-shine-advanced', 'cloudTopsEnabled')
              ?? tileDoc?.flags?.['map-shine-advanced']?.cloudTopsEnabled;
            const cloudShadowsEnabled = (cloudShadowsFlag === undefined) ? true : !!cloudShadowsFlag;
            const cloudTopsEnabled = (cloudTopsFlag === undefined) ? true : !!cloudTopsFlag;

            const shadowBlockExpected = !cloudShadowsEnabled;
            const topBlockExpected = !cloudTopsEnabled;

            const shadowBlockLayer = TILE_FEATURE_LAYERS?.CLOUD_SHADOW_BLOCKER;
            const topBlockLayer = TILE_FEATURE_LAYERS?.CLOUD_TOP_BLOCKER;

            if (typeof shadowBlockLayer === 'number') {
              const enabled = layerEnabled(sprite, shadowBlockLayer);
              if (enabled !== shadowBlockExpected) {
                results.push({ kind: 'surface', effectId: tileId, paramId: 'layers.cloudShadowBlocker', status: 'FAIL', error: `layer=${shadowBlockLayer} enabled=${enabled} expected=${shadowBlockExpected}` });
              }
            }

            if (typeof topBlockLayer === 'number') {
              const enabled = layerEnabled(sprite, topBlockLayer);
              if (enabled !== topBlockExpected) {
                results.push({ kind: 'surface', effectId: tileId, paramId: 'layers.cloudTopBlocker', status: 'FAIL', error: `layer=${topBlockLayer} enabled=${enabled} expected=${topBlockExpected}` });
              }
            }

            const occludesWaterFlag = tileDoc?.getFlag?.('map-shine-advanced', 'occludesWater')
              ?? tileDoc?.flags?.['map-shine-advanced']?.occludesWater;
            const expectedOccludesWater = !!occludesWaterFlag;
            const waterOccEnabled = layerEnabled(sprite, WATER_OCCLUDER_LAYER);
            if (waterOccEnabled !== expectedOccludesWater) {
              results.push({ kind: 'surface', effectId: tileId, paramId: 'layers.waterOccluder', status: 'FAIL', error: `layer=${WATER_OCCLUDER_LAYER} enabled=${waterOccEnabled} expected=${expectedOccludesWater}` });
            }
          }
        }
      } catch (e) {
        results.push({ kind: 'surface', paramId: 'surfaceReport', status: 'FAIL', error: e });
      }
    } finally {
      this.globalParams.mapMakerMode = originalGlobals.mapMakerMode;
      this.globalParams.timeRate = originalGlobals.timeRate;

      this.uiScale = originalUiScale;
      this.uiScaleParams.scale = originalUiScaleBinding;
      this.updateScale();

      for (const [effectId, params] of Object.entries(originalEffects)) {
        const effectData = this.effectFolders[effectId];
        if (!effectData?.params) continue;
        Object.assign(effectData.params, params);
        for (const [paramId] of Object.entries(params)) {
          if (effectData.bindings?.[paramId]) {
            effectData.bindings[paramId].refresh();
          }
        }
      }

      for (const id of savedQueue) this.saveQueue.add(id);
      this._uiValidatorActive = false;
      this._uiValidatorRunning = false;
      if (validatorButton) validatorButton.disabled = false;
    }

    const pass = results.filter(r => r.status === 'PASS').length;
    const fail = results.filter(r => r.status === 'FAIL').length;
    const skip = results.filter(r => r.status === 'SKIP').length;

    console.groupCollapsed(`Map Shine UI Validator: ${pass} pass, ${fail} fail, ${skip} skip`);
    if (fail > 0) {
      const failures = results.filter(r => r.status === 'FAIL').map(r => ({
        kind: r.kind,
        effectId: r.effectId,
        paramId: r.paramId,
        error: r.error?.stack || r.error?.message || String(r.error)
      }));
      console.table(failures);
    }
    console.groupEnd();

    if (fail > 0) {
      log.warn(`UI Validator found ${fail} failure(s). See console for details.`);
    } else {
      log.info('UI Validator completed with no failures.');
    }
  }

  /**
   * Get performance metrics
   * @returns {Object} Performance data
   */
  getPerformance() {
    return {
      ...this.perf,
      uiFrameRate: this.uiFrameRate,
      running: this.running
    };
  }

  /**
   * Open a dialog to select effect type and start map point drawing
   */
  openMapPointDrawingDialog() {
    const interactionManager = window.MapShine?.interactionManager;
    const mapPointsManager = window.MapShine?.mapPointsManager;
    if (!interactionManager) {
      ui.notifications.warn('Interaction manager not available');
      return;
    }

    // Get last used effect
    const lastEffect = interactionManager.getLastEffectTarget();

    // Effect options from EFFECT_SOURCE_OPTIONS
    const effectOptions = {
      rope: 'Rope',
      smellyFlies: 'Smelly Flies',
      fire: 'Fire Particles',
      candleFlame: 'Candle Flame',
      sparks: 'Sparks',
      dust: 'Dust Motes',
      lightning: 'Lightning',
      pressurisedSteam: 'Pressurised Steam',
      water: 'Water Surface',
      cloudShadows: 'Cloud Shadows',
      canopy: 'Canopy Shadows',
      structuralShadows: 'Structural Shadows'
    };

    // Group type options
    const groupTypeOptions = {
      area: 'Area (Polygon)',
      point: 'Single Point',
      line: 'Line'
    };

    const ropeTypeOptions = {
      rope: 'Rope (Flexible)',
      chain: 'Chain (Heavy)'
    };

    const lastRopeType = (() => {
      try {
        const saved = game.settings.get('map-shine-advanced', 'rope-default-behavior');
        if (saved && typeof saved === 'object') {
          return (saved._lastRopeType === 'rope' || saved._lastRopeType === 'chain') ? saved._lastRopeType : 'chain';
        }
      } catch (e) {
      }
      return 'chain';
    })();

    // Count existing groups
    const existingGroupCount = mapPointsManager?.groups?.size || 0;
    const showHelpers = mapPointsManager?.showVisualHelpers || false;

    // Build dialog content
    const content = `
      <form>
        <div class="form-group">
          <label>Effect Type</label>
          <select name="effectTarget" style="width: 100%;">
            ${Object.entries(effectOptions).map(([key, label]) => 
              `<option value="${key}" ${key === lastEffect ? 'selected' : ''}>${label}</option>`
            ).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Group Type</label>
          <select name="groupType" style="width: 100%;">
            ${Object.entries(groupTypeOptions).map(([key, label]) => 
              `<option value="${key}" ${key === 'area' ? 'selected' : ''}>${label}</option>`
            ).join('')}
          </select>
        </div>

        <div class="form-group rope-type-row" style="display:none;">
          <label>Rope Type</label>
          <select name="ropeType" style="width: 100%;">
            ${Object.entries(ropeTypeOptions).map(([key, label]) =>
              `<option value="${key}" ${key === lastRopeType ? 'selected' : ''}>${label}</option>`
            ).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>
            <input type="checkbox" name="snapToGrid" style="margin-right: 6px;">
            Snap to Grid (half-grid subdivisions)
          </label>
          <p class="notes" style="margin: 4px 0 0 0; font-size: 10px; color: #666;">
            When enabled, points snap to grid. Hold Shift to temporarily toggle.
          </p>
        </div>
        <hr style="margin: 12px 0; border: none; border-top: 1px solid #444;">
        <div class="form-group" style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-size: 11px; color: #888;">
            ${existingGroupCount} existing group${existingGroupCount !== 1 ? 's' : ''} on this scene
          </span>
          <label style="font-size: 11px; cursor: pointer;">
            <input type="checkbox" name="showExisting" ${showHelpers ? 'checked' : ''} style="margin-right: 4px;">
            Show existing
          </label>
        </div>
        <hr style="margin: 12px 0; border: none; border-top: 1px solid #444;">
        <div style="background: #1a1a2e; padding: 10px; border-radius: 4px; margin-top: 8px;">
          <p style="margin: 0 0 6px 0; font-size: 11px; color: #aaa; font-weight: bold;">Controls:</p>
          <ul style="margin: 0; padding-left: 16px; font-size: 10px; color: #888; line-height: 1.6;">
            <li><strong>Click</strong> - Place a point</li>
            <li><strong>Double-click</strong> or <strong>Enter</strong> - Finish drawing</li>
            <li><strong>Backspace</strong> - Remove last point</li>
            <li><strong>Escape</strong> - Cancel drawing</li>
            <li><strong>Shift</strong> - Toggle grid snap</li>
          </ul>
        </div>
      </form>
    `;

    new Dialog({
      title: 'Draw Map Points',
      content,
      buttons: {
        draw: {
          icon: '<i class="fas fa-crosshairs"></i>',
          label: 'Start Drawing',
          callback: (html) => {
            const effectTarget = html.find('[name="effectTarget"]').val();
            const groupTypeRaw = html.find('[name="groupType"]').val();
            const snapToGrid = html.find('[name="snapToGrid"]').is(':checked');
            const groupType = effectTarget === 'rope' ? 'line' : groupTypeRaw;
            const ropeType = html.find('[name="ropeType"]').val();
            const ropePreset = (ropeType === 'rope' || ropeType === 'chain') ? ropeType : 'chain';
            try {
              if (effectTarget === 'rope') {
                const saved = game.settings.get('map-shine-advanced', 'rope-default-behavior');
                const next = (saved && typeof saved === 'object') ? { ...saved } : {};
                next._lastRopeType = ropePreset;
                void game.settings.set('map-shine-advanced', 'rope-default-behavior', next);
              }
            } catch (e) {
            }
            interactionManager.startMapPointDrawing(effectTarget, groupType, snapToGrid, { ropeType: ropePreset });
          }
        },
        manage: {
          icon: '<i class="fas fa-list"></i>',
          label: 'Manage Existing',
          callback: () => {
            this.openMapPointsManagerDialog();
          }
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: 'Cancel'
        }
      },
      default: 'draw',
      render: (html) => {
        // Prevent UI clicks from leaking through to the underlying canvas.
        html.closest('.app.window-app')?.on('pointerdown', (ev) => {
          ev.stopPropagation();
        });

        const updateGroupTypeForRope = () => {
          const effectTarget = html.find('[name="effectTarget"]').val();
          const typeSelect = html.find('[name="groupType"]');
          const isRope = effectTarget === 'rope';
          typeSelect.prop('disabled', isRope);
          if (isRope) typeSelect.val('line');

          html.find('.rope-type-row').css('display', isRope ? 'block' : 'none');
        };

        html.find('[name="effectTarget"]').on('change', updateGroupTypeForRope);
        updateGroupTypeForRope();

        // Handle "Show existing" checkbox toggle
        html.find('[name="showExisting"]').on('change', (ev) => {
          const show = ev.target.checked;
          if (mapPointsManager) {
            mapPointsManager.setShowVisualHelpers(show);
          }
        });
      }
    }).render(true);
  }

  /**
   * Open a dialog to manage existing map point groups
   */
  openMapPointsManagerDialog() {
    const mapPointsManager = window.MapShine?.mapPointsManager;
    const interactionManager = window.MapShine?.interactionManager;
    
    if (!mapPointsManager) {
      ui.notifications.warn('Map Points Manager not available');
      return;
    }

    // Effect options for editing
    const effectOptions = {
      '': 'None',
      rope: 'Rope',
      smellyFlies: 'Smelly Flies',
      fire: 'Fire Particles',
      candleFlame: 'Candle Flame',
      sparks: 'Sparks',
      dust: 'Dust Motes',
      lightning: 'Lightning',
      pressurisedSteam: 'Pressurised Steam',
      water: 'Water Surface',
      cloudShadows: 'Cloud Shadows',
      canopy: 'Canopy Shadows',
      structuralShadows: 'Structural Shadows'
    };

    // Group type labels
    const groupTypeLabels = {
      area: 'Area',
      point: 'Point',
      line: 'Line',
      rope: 'Rope'
    };

    // Build groups list HTML
    const buildGroupsList = () => {
      const groups = Array.from(mapPointsManager.groups.values());
      
      if (groups.length === 0) {
        return `
          <div style="text-align: center; padding: 20px; color: #888;">
            <i class="fas fa-map-marker-alt" style="font-size: 24px; margin-bottom: 8px; display: block;"></i>
            No map point groups on this scene.<br>
            <small>Use "Draw New" to create one.</small>
          </div>
        `;
      }

      return groups.map(group => {
        const color = mapPointsManager.getEffectColor(group.effectTarget);
        const colorHex = '#' + color.toString(16).padStart(6, '0');
        const effectLabel = effectOptions[group.effectTarget] || group.effectTarget || 'None';
        const typeLabel = group.effectTarget === 'rope' ? 'Rope' : (groupTypeLabels[group.type] || group.type);
        const pointCount = group.points?.length || 0;
        
        return `
          <div class="map-point-group-item" data-group-id="${group.id}" style="
            display: flex;
            align-items: center;
            padding: 8px 10px;
            margin-bottom: 6px;
            background: #2a2a3e;
            border-radius: 4px;
            border-left: 4px solid ${colorHex};
            cursor: pointer;
            transition: background 0.15s;
          " onmouseover="this.style.background='#3a3a4e'" onmouseout="this.style.background='#2a2a3e'">
            <div style="flex: 1; min-width: 0;">
              <div style="font-weight: bold; font-size: 12px; color: #ddd; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                ${group.label || 'Unnamed Group'}
              </div>
              <div style="font-size: 10px; color: #888; margin-top: 2px;">
                ${typeLabel} • ${effectLabel} • ${pointCount} point${pointCount !== 1 ? 's' : ''}
              </div>
            </div>
            <div style="display: flex; gap: 4px; margin-left: 8px;">
              <button type="button" class="group-action-btn group-edit-btn" data-action="edit" data-group-id="${group.id}" 
                style="padding: 4px 8px; font-size: 10px; background: #4a4a6a; border: none; border-radius: 3px; color: #ddd; cursor: pointer;"
                title="Edit group">
                <i class="fas fa-edit"></i>
              </button>
              <button type="button" class="group-action-btn group-focus-btn" data-action="focus" data-group-id="${group.id}"
                style="padding: 4px 8px; font-size: 10px; background: #4a4a6a; border: none; border-radius: 3px; color: #ddd; cursor: pointer;"
                title="Focus on group">
                <i class="fas fa-crosshairs"></i>
              </button>
              <button type="button" class="group-action-btn group-delete-btn" data-action="delete" data-group-id="${group.id}"
                style="padding: 4px 8px; font-size: 10px; background: #6a3a3a; border: none; border-radius: 3px; color: #ddd; cursor: pointer;"
                title="Delete group">
                <i class="fas fa-trash"></i>
              </button>
            </div>
          </div>
        `;
      }).join('');
    };

    const content = `
      <div class="map-points-manager-dialog">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <label style="font-size: 11px; cursor: pointer;">
            <input type="checkbox" name="showHelpers" ${mapPointsManager.showVisualHelpers ? 'checked' : ''} style="margin-right: 6px;">
            Show visual helpers
          </label>
          <span style="font-size: 11px; color: #888;">
            ${mapPointsManager.groups.size} group${mapPointsManager.groups.size !== 1 ? 's' : ''}
          </span>
        </div>
        <div class="groups-list" style="max-height: 300px; overflow-y: auto; margin-bottom: 12px;">
          ${buildGroupsList()}
        </div>
      </div>
    `;

    const dialog = new Dialog({
      title: 'Manage Map Points',
      content,
      buttons: {
        drawNew: {
          icon: '<i class="fas fa-plus"></i>',
          label: 'Draw New',
          callback: () => {
            this.openMapPointDrawingDialog();
          }
        },
        close: {
          icon: '<i class="fas fa-times"></i>',
          label: 'Close',
          callback: () => {
            mapPointsManager.setShowVisualHelpers(false);
          }
        }
      },
      default: 'close',
      close: () => {
        mapPointsManager.setShowVisualHelpers(false);
      },
      render: (html) => {
        // Prevent UI clicks from leaking through to the underlying canvas.
        html.closest('.app.window-app')?.on('pointerdown', (ev) => {
          ev.stopPropagation();
        });

        // Handle show helpers toggle
        html.find('[name="showHelpers"]').on('change', (ev) => {
          mapPointsManager.setShowVisualHelpers(ev.target.checked);
        });

        // Handle group action buttons
        html.find('.group-action-btn').on('click', async (ev) => {
          ev.stopPropagation();
          const btn = ev.currentTarget;
          const action = btn.dataset.action;
          const groupId = btn.dataset.groupId;
          
          if (action === 'delete') {
            const group = mapPointsManager.getGroup(groupId);
            const confirmed = await Dialog.confirm({
              title: 'Delete Map Point Group',
              content: `<p>Are you sure you want to delete "${group?.label || 'this group'}"?</p><p>This cannot be undone.</p>`,
              yes: () => true,
              no: () => false
            });
            
            if (confirmed) {
              const ok = await mapPointsManager.deleteGroup(groupId);
              if (ok) {
                ui.notifications.info('Map point group deleted');
                dialog.close();
                this.openMapPointsManagerDialog();
              } else {
                ui.notifications.warn('Failed to delete map point group (insufficient permissions or save error).');
              }
            }
          } else if (action === 'edit') {
            dialog.close();
            this.openGroupEditDialog(groupId);
          } else if (action === 'focus') {
            const group = mapPointsManager.getGroup(groupId);
            if (group && group.points && group.points.length > 0) {
              // Calculate center of group
              const bounds = mapPointsManager.getAreaBounds(groupId) || mapPointsManager._computeBounds(group.points);
              if (bounds) {
                // Pan canvas to center on group
                const foundryPos = Coordinates.toFoundry(bounds.centerX, bounds.centerY);
                canvas.pan({ x: foundryPos.x, y: foundryPos.y });
                // Ensure helpers are visible
                mapPointsManager.setShowVisualHelpers(true);
                html.find('[name="showHelpers"]').prop('checked', true);
              }
            }
          }
        });

        // Handle clicking on a group item (select/highlight)
        html.find('.map-point-group-item').on('click', (ev) => {
          if (ev.target.closest('.group-action-btn')) return;
          
          const groupId = ev.currentTarget.dataset.groupId;
          const group = mapPointsManager.getGroup(groupId);
          
          if (group && group.points && group.points.length > 0) {
            const bounds = mapPointsManager.getAreaBounds(groupId) || mapPointsManager._computeBounds(group.points);
            if (bounds) {
              const foundryPos = Coordinates.toFoundry(bounds.centerX, bounds.centerY);
              canvas.pan({ x: foundryPos.x, y: foundryPos.y });
              mapPointsManager.setShowVisualHelpers(true);
              html.find('[name="showHelpers"]').prop('checked', true);
            }
          }
        });
      }
    }, {
      width: 400,
      height: 'auto'
    });
    
    dialog.render(true);
  }

  /**
   * Open a dialog to edit a specific map point group
   * @param {string} groupId - ID of the group to edit
   */
  openGroupEditDialog(groupId) {
    const mapPointsManager = window.MapShine?.mapPointsManager;
    if (!mapPointsManager) return;

    const group = mapPointsManager.getGroup(groupId);
    if (!group) {
      ui.notifications.warn('Group not found');
      return;
    }

    // Effect options
    const effectOptions = {
      '': 'None',
      rope: 'Rope',
      smellyFlies: 'Smelly Flies',
      fire: 'Fire Particles',
      candleFlame: 'Candle Flame',
      sparks: 'Sparks',
      dust: 'Dust Motes',
      lightning: 'Lightning',
      pressurisedSteam: 'Pressurised Steam',
      water: 'Water Surface',
      cloudShadows: 'Cloud Shadows',
      canopy: 'Canopy Shadows',
      structuralShadows: 'Structural Shadows'
    };

    // Group type options
    const groupTypeOptions = {
      area: 'Area (Polygon)',
      point: 'Single Point',
      line: 'Line'
    };

    const ropeTypeOptions = {
      rope: 'Rope (Flexible)',
      chain: 'Chain (Heavy)'
    };

    const ropeTypePresetDefaults = {
      rope: {
        ropeType: 'rope',
        segmentLength: 12,
        damping: 0.98,
        windForce: 1.2,
        springConstant: 0.6,
        tapering: 0.55,
        width: 22,
        uvRepeatWorld: 64,
        ropeEndStiffness: 0.25,
        texturePath: group.texturePath || 'modules/map-shine-advanced/assets/rope.webp'
      },
      chain: {
        ropeType: 'chain',
        segmentLength: 22,
        damping: 0.92,
        windForce: 0.25,
        springConstant: 1.0,
        tapering: 0.15,
        width: 18,
        uvRepeatWorld: 48,
        ropeEndStiffness: 0.5,
        texturePath: group.texturePath || 'modules/map-shine-advanced/assets/rope.webp'
      }
    };

    const ropeTypeValue = (group.ropeType === 'rope' || group.ropeType === 'chain') ? group.ropeType : 'chain';
    const texturePathValue = (typeof group.texturePath === 'string' && group.texturePath.trim().length > 0)
      ? group.texturePath.trim()
      : 'modules/map-shine-advanced/assets/rope.webp';

    const pointCount = group.points?.length || 0;

    const h = canvas?.dimensions?.height;
    const pointsListHtml = (pointCount > 0)
      ? `
        <div class="points-list" style="margin-top: 10px; max-height: 140px; overflow: auto;">
          ${group.points.map((p, idx) => {
            const x = Number(p?.x);
            const yWorld = Number(p?.y);
            const y = Number.isFinite(h) ? (h - yWorld) : yWorld;
            const xTxt = Number.isFinite(x) ? x.toFixed(0) : '—';
            const yTxt = Number.isFinite(y) ? y.toFixed(0) : '—';
            return `
              <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:4px 0; border-top: 1px solid rgba(255,255,255,0.06);">
                <span style="font-size: 10px; color: #aaa;">#${idx + 1}: (${xTxt}, ${yTxt})</span>
                <button type="button" class="remove-point-btn" data-point-index="${idx}" style="
                  padding: 2px 8px;
                  font-size: 10px;
                  background: rgba(180, 60, 60, 0.65);
                  border: none;
                  border-radius: 3px;
                  color: #eee;
                  cursor: pointer;
                ">
                  <i class="fas fa-times"></i>
                </button>
              </div>
            `;
          }).join('')}
        </div>
      `
      : `<div style="margin-top: 10px; font-size: 10px; color: #666;">No points yet.</div>`;

    const isRopeGroup = group.effectTarget === 'rope' || group.type === 'rope';

    const content = `
      <style>
        form.group-edit-form.mapshine-map-point-edit .rope-controls,
        form.group-edit-form.mapshine-map-point-edit .rope-controls * {
          color: #ddd;
        }
        form.group-edit-form.mapshine-map-point-edit .rope-controls .notes {
          color: #aaa;
        }
        form.group-edit-form.mapshine-map-point-edit .rope-controls input,
        form.group-edit-form.mapshine-map-point-edit .rope-controls select {
          background: rgba(0, 0, 0, 0.25);
          color: #ddd;
          border: 1px solid rgba(255, 255, 255, 0.15);
        }
        form.group-edit-form.mapshine-map-point-edit .rope-controls input::placeholder {
          color: rgba(255, 255, 255, 0.45);
        }
        form.group-edit-form.mapshine-map-point-edit .rope-texture-browse,
        form.group-edit-form.mapshine-map-point-edit .add-points-btn,
        form.group-edit-form.mapshine-map-point-edit .clear-points-btn,
        form.group-edit-form.mapshine-map-point-edit .remove-point-btn {
          width: auto !important;
          min-width: 0;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          line-height: 1;
        }
        form.group-edit-form.mapshine-map-point-edit .points-list .remove-point-btn {
          flex: 0 0 auto;
        }
      </style>
      <form class="group-edit-form mapshine-map-point-edit">
        <div class="form-group">
          <label>Label</label>
          <input type="text" name="label" value="${group.label || ''}" style="width: 100%;" placeholder="Group name">
        </div>
        <div class="form-group">
          <label>Effect Type</label>
          <select name="effectTarget" style="width: 100%;">
            ${Object.entries(effectOptions).map(([key, label]) => 
              `<option value="${key}" ${key === group.effectTarget ? 'selected' : ''}>${label}</option>`
            ).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Group Type</label>
          <select name="type" style="width: 100%;">
            ${Object.entries(groupTypeOptions).map(([key, label]) => 
              `<option value="${key}" ${key === group.type ? 'selected' : ''}>${label}</option>`
            ).join('')}
          </select>
        </div>

        <div class="rope-controls" style="display: ${isRopeGroup ? 'block' : 'none'};">
          <hr style="margin: 12px 0; border: none; border-top: 1px solid #444;">
          <div style="background: #1a1a2e; padding: 10px; border-radius: 4px;">
            <div class="form-group">
              <label>Rope Preset</label>
              <select name="ropeType" style="width: 100%;">
                ${Object.entries(ropeTypeOptions).map(([key, label]) =>
                  `<option value="${key}" ${key === ropeTypeValue ? 'selected' : ''}>${label}</option>`
                ).join('')}
              </select>
              <p class="notes" style="margin: 4px 0 0 0; font-size: 10px; color: #666;">
                Presets set physics defaults (you can still edit values later).
              </p>
            </div>

            <div class="form-group" style="display:flex; gap:6px; align-items:center;">
              <label style="flex: 0 0 70px;">Texture</label>
              <input type="text" name="ropeTexturePath" value="${texturePathValue}" style="flex: 1;" placeholder="modules/.../rope.webp">
              <button type="button" class="rope-texture-browse" style="
                padding: 4px 8px;
                font-size: 10px;
                background: #4a4a6a;
                border: none;
                border-radius: 3px;
                color: #ddd;
                cursor: pointer;
              ">
                <i class="fas fa-file-image"></i>
              </button>
            </div>

            <div class="form-group">
              <label>Segment Length</label>
              <input type="range" name="ropeSegmentLength" min="6" max="64" step="1" value="${Number(group.segmentLength ?? (ropeTypePresetDefaults[ropeTypeValue]?.segmentLength ?? 20))}" style="width: 100%;">
              <span class="rope-seglen-value" style="font-size: 10px; color: #888;"></span>
            </div>
          </div>
        </div>

        <div class="form-group">
          <label>
            <input type="checkbox" name="isEffectSource" ${group.isEffectSource ? 'checked' : ''} style="margin-right: 6px;">
            Active (drives effect)
          </label>
        </div>
        <hr style="margin: 12px 0; border: none; border-top: 1px solid #444;">
        <div class="form-group">
          <label>Emission Intensity</label>
          <input type="range" name="emissionIntensity" min="0" max="1" step="0.05" 
            value="${group.emission?.intensity ?? 1.0}" style="width: 100%;">
          <span class="intensity-value" style="font-size: 10px; color: #888;">${((group.emission?.intensity ?? 1.0) * 100).toFixed(0)}%</span>
        </div>
        <hr style="margin: 12px 0; border: none; border-top: 1px solid #444;">
        <div style="background: #1a1a2e; padding: 10px; border-radius: 4px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 11px; color: #aaa;">
              <strong>${pointCount}</strong> point${pointCount !== 1 ? 's' : ''}
            </span>
            <div style="display: flex; gap: 4px;">
              <button type="button" class="add-points-btn" style="
                padding: 4px 10px; 
                font-size: 10px; 
                background: #3a5a3a; 
                border: none; 
                border-radius: 3px; 
                color: #ddd; 
                cursor: pointer;
              ">
                <i class="fas fa-plus"></i> Add Points
              </button>
              <button type="button" class="clear-points-btn" style="
                padding: 4px 10px; 
                font-size: 10px; 
                background: #6a3a3a; 
                border: none; 
                border-radius: 3px; 
                color: #ddd; 
                cursor: pointer;
              ">
                <i class="fas fa-eraser"></i> Clear
              </button>
            </div>
          </div>
          <p style="margin: 8px 0 0 0; font-size: 10px; color: #666;">
            Click "Add Points" to add more points to this group.
          </p>
          ${pointsListHtml}
        </div>
      </form>
    `;

    const dialog = new Dialog({
      title: `Edit: ${group.label || 'Map Point Group'}`,
      content,
      buttons: {
        save: {
          icon: '<i class="fas fa-save"></i>',
          label: 'Save',
          callback: async (html) => {
            const nextTypeRaw = html.find('[name="type"]').val();
            const nextEffectRaw = html.find('[name="effectTarget"]').val();
            const isRope = nextEffectRaw === 'rope' || nextTypeRaw === 'rope';
            const nextType = isRope ? 'line' : nextTypeRaw;
            const nextEffect = isRope ? 'rope' : nextEffectRaw;

            const updates = {
              label: html.find('[name="label"]').val(),
              effectTarget: nextEffect,
              type: nextType,
              isEffectSource: isRope ? false : html.find('[name="isEffectSource"]').is(':checked'),
              emission: {
                ...group.emission,
                intensity: parseFloat(html.find('[name="emissionIntensity"]').val())
              }
            };

            if (isRope) {
              const ropeType = html.find('[name="ropeType"]').val();
              const presetKey = (ropeType === 'rope' || ropeType === 'chain') ? ropeType : 'chain';
              const preset = ropeTypePresetDefaults[presetKey];
              updates.ropeType = preset.ropeType;
              updates.segmentLength = Number(html.find('[name="ropeSegmentLength"]').val()) || preset.segmentLength;
              updates.texturePath = String(html.find('[name="ropeTexturePath"]').val() || preset.texturePath);
              updates.damping = preset.damping;
              updates.windForce = preset.windForce;
              updates.springConstant = preset.springConstant;
              updates.tapering = preset.tapering;
              updates.width = preset.width;
              updates.uvRepeatWorld = preset.uvRepeatWorld;
              updates.ropeEndStiffness = preset.ropeEndStiffness;
            }
            
            await mapPointsManager.updateGroup(groupId, updates);
            ui.notifications.info('Group updated');
            
            // Refresh visual helpers if visible
            if (mapPointsManager.showVisualHelpers) {
              mapPointsManager.setShowVisualHelpers(false);
              mapPointsManager.setShowVisualHelpers(true);
            }
          }
        },
        back: {
          icon: '<i class="fas fa-arrow-left"></i>',
          label: 'Back',
          callback: () => {
            this.openMapPointsManagerDialog();
          }
        },
        delete: {
          icon: '<i class="fas fa-trash"></i>',
          label: 'Delete',
          callback: async () => {
            const confirmed = await Dialog.confirm({
              title: 'Delete Map Point Group',
              content: `<p>Are you sure you want to delete "${group.label || 'this group'}"?</p>`,
              yes: () => true,
              no: () => false
            });
            
            if (confirmed) {
              const ok = await mapPointsManager.deleteGroup(groupId);
              if (ok) {
                ui.notifications.info('Group deleted');
                this.openMapPointsManagerDialog();
              } else {
                ui.notifications.warn('Failed to delete group (insufficient permissions or save error).');
              }
            }
          }
        }
      },
      default: 'save',
      render: (html) => {
        // Prevent UI clicks from leaking through to the underlying canvas.
        html.closest('.app.window-app')?.on('pointerdown', (ev) => {
          ev.stopPropagation();
        });

        // Prevent accidental Dialog submission (and closure) when selecting files in FilePicker.
        // Foundry Dialogs trigger the default button on Enter; FilePicker interactions can leak
        // an Enter key event back into this window.
        html.closest('.app.window-app')?.on('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === 'NumpadEnter') {
            ev.preventDefault();
            ev.stopPropagation();
          }
        });

        const updateRopeControlsVisibility = () => {
          const t = html.find('[name="type"]').val();
          const e = html.find('[name="effectTarget"]').val();
          const isRope = e === 'rope' || t === 'rope';
          html.find('.rope-controls').css('display', isRope ? 'block' : 'none');
          html.find('[name="effectTarget"]').prop('disabled', isRope);
          html.find('[name="isEffectSource"]').prop('disabled', isRope);
          html.find('[name="type"]').prop('disabled', isRope);
          if (isRope) {
            html.find('[name="effectTarget"]').val('rope');
            html.find('[name="isEffectSource"]').prop('checked', false);
            html.find('[name="type"]').val('line');
          }
        };

        html.find('[name="type"]').on('change', updateRopeControlsVisibility);
        html.find('[name="effectTarget"]').on('change', updateRopeControlsVisibility);
        updateRopeControlsVisibility();

        const updateSegLenText = () => {
          const v = Number(html.find('[name="ropeSegmentLength"]').val());
          html.find('.rope-seglen-value').text(Number.isFinite(v) ? `${v}px` : '');
        };
        html.find('[name="ropeSegmentLength"]').on('input', updateSegLenText);
        updateSegLenText();

        html.find('.rope-texture-browse').on('click', async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();

          const filePickerImpl = globalThis.foundry?.applications?.apps?.FilePicker?.implementation;
          const FilePickerCls = filePickerImpl ?? globalThis.FilePicker;
          if (!FilePickerCls) {
            ui.notifications.warn('FilePicker not available');
            return;
          }

          const fp = new FilePickerCls({
            type: 'image',
            current: html.find('[name="ropeTexturePath"]').val() || '',
            callback: (path) => {
              html.find('[name="ropeTexturePath"]').val(path);
            }
          });
          fp.browse();
        });

        // Update intensity display
        html.find('[name="emissionIntensity"]').on('input', (ev) => {
          const val = parseFloat(ev.target.value);
          html.find('.intensity-value').text(`${(val * 100).toFixed(0)}%`);
        });

        // Remove a single point
        html.find('.remove-point-btn').on('click', async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const idx = parseInt(ev.currentTarget.dataset.pointIndex);
          if (!Number.isFinite(idx)) return;

          const confirmed = await Dialog.confirm({
            title: 'Remove Point',
            content: '<p>Remove this point from the group?</p>',
            yes: () => true,
            no: () => false
          });
          if (!confirmed) return;

          await mapPointsManager.removePoint(groupId, idx);
          ui.notifications.info('Point removed');

          dialog.close();
          this.openGroupEditDialog(groupId);
        });

        // Add points button
        html.find('.add-points-btn').on('click', () => {
          dialog.close();
          const interactionManager = window.MapShine?.interactionManager;
          if (interactionManager?.startAddPointsToGroup) {
            interactionManager.startAddPointsToGroup(groupId);
          }
        });

        // Clear all points button
        html.find('.clear-points-btn').on('click', async () => {
          const confirmed = await Dialog.confirm({
            title: 'Clear All Points',
            content: '<p>Remove all points from this group? This cannot be undone.</p>',
            yes: () => true,
            no: () => false
          });
          
          if (confirmed) {
            await mapPointsManager.updateGroup(groupId, { points: [] });
            ui.notifications.info('All points cleared');
            dialog.close();
            this.openGroupEditDialog(groupId);
          }
        });

        // Focus on group
        const bounds = mapPointsManager.getAreaBounds(groupId) || mapPointsManager._computeBounds(group.points);
        if (bounds) {
          const worldY = bounds.centerY;
          const foundryY = Number.isFinite(h) ? (h - worldY) : worldY;
          canvas.pan({ x: bounds.centerX, y: foundryY });
        }
        mapPointsManager.setShowVisualHelpers(true);
      }
    }, {
      width: 350
    });

    dialog.render(true);
  }
}

/**
 * Register UI settings with Foundry
 * Should be called during 'init' hook
 * @public
 */
export function registerUISettings() {
  game.settings.register('map-shine-advanced', 'ui-state', {
    name: 'UI State',
    hint: 'Stores UI panel position, scale, and accordion states',
    scope: 'client',
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register('map-shine-advanced', 'texture-manager-state', {
    name: 'Texture Manager State',
    scope: 'client',
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register('map-shine-advanced', 'effect-stack-state', {
    name: 'Effect Stack State',
    scope: 'client',
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register('map-shine-advanced', 'rope-default-textures', {
    name: 'Rope Default Textures',
    scope: 'world',
    config: false,
    type: Object,
    default: {
      ropeTexturePath: 'modules/map-shine-advanced/assets/rope.webp',
      chainTexturePath: 'modules/map-shine-advanced/assets/rope.webp'
    }
  });

  game.settings.register('map-shine-advanced', 'rope-default-behavior', {
    name: 'Rope Default Behavior',
    scope: 'world',
    config: false,
    type: Object,
    default: {
      rope: {
        segmentLength: 12,
        damping: 0.98,
        windForce: 1.2,
        springConstant: 0.6,
        tapering: 0.55,
        width: 22,
        uvRepeatWorld: 64,
        ropeEndStiffness: 0.25
      },
      chain: {
        segmentLength: 22,
        damping: 0.92,
        windForce: 0.25,
        springConstant: 1.0,
        tapering: 0.15,
        width: 18,
        uvRepeatWorld: 48,
        ropeEndStiffness: 0.5
      },
      _lastRopeType: 'chain'
    }
  });

  log.info('UI settings registered');
}
