/**
 * @fileoverview Tweakpane UI Manager for Map Shine Advanced
 * Manages the parameter control panel with performance optimizations
 * @module ui/tweakpane-manager
 */

import { createLogger } from '../core/log.js';
import { globalValidator, getSpecularEffectiveState, getStripeDependencyState } from './parameter-validator.js';
import { TextureManagerUI } from './texture-manager.js';

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
    this.visible = true;
    
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
      timeRate: 100 // 0-100%
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

    /** @type {number} UI scale factor */
    this.uiScale = 1.0;
  }

  /**
   * Initialize the UI panel
   * @param {HTMLElement} [parentElement] - Optional parent element (defaults to body)
   * @returns {Promise<void>}
   */
  async initialize(parentElement = document.body) {
    if (this.pane) {
      log.warn('TweakpaneManager already initialized');
      return;
    }

    // Wait for Tweakpane to be available (up to 5 seconds)
    log.info('Waiting for Tweakpane library to load...');
    const startTime = Date.now();
    while (typeof Tweakpane === 'undefined' && (Date.now() - startTime) < 5000) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

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
    await this.loadUIState();

    // Build global controls
    this.buildGlobalControls();

    // Build scene setup section (only for GMs)
    if (game.user.isGM) {
      this.buildSceneSetupSection();
    }

    // Build branding section
    this.buildBrandingSection();

    // Start UI update loop
    this.startUILoop();

    // Make pane draggable
    this.makeDraggable();

    // Initialize Texture Manager
    this.textureManager = new TextureManagerUI();
    await this.textureManager.initialize();

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
    globalFolder.addBinding(this.globalParams, 'mapMakerMode', {
      label: 'Map Maker Mode'
    }).on('change', (ev) => {
      this.onGlobalChange('mapMakerMode', ev.value);
    });

    // Time rate slider
    globalFolder.addBinding(this.globalParams, 'timeRate', {
      label: 'Time Rate',
      min: 0,
      max: 200,
      step: 1
    }).on('change', (ev) => {
      this.onGlobalChange('timeRate', ev.value);
    });

    // Visual separator between time controls and UI/tools controls
    globalFolder.addBlade({ view: 'separator' });

    // UI Scale
    globalFolder.addBinding({ scale: this.uiScale }, 'scale', {
      label: 'UI Scale',
      min: 0.5,
      max: 2.0,
      step: 0.1
    }).on('change', (ev) => {
      this.uiScale = ev.value;
      
      // Only update UI scale after user releases the mouse (0.1s delay)
      // This prevents the UI from "running away" under the cursor while dragging
      if (ev.last) {
        setTimeout(() => {
          this.updateScale();
          this.saveUIState();
        }, 100);
      }
    });

    // Texture Manager Button
    globalFolder.addButton({
      title: 'Open Texture Manager',
      label: 'Tools'
    }).on('click', () => {
      if (this.textureManager) {
        this.textureManager.toggle();
      }
    });

    // Track accordion state
    globalFolder.on('fold', (ev) => {
      this.accordionStates['global'] = ev.expanded;
      this.saveUIState();
    });
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
      expanded: this.accordionStates['branding'] ?? false
    });

    // Add HTML element for links
    const linkContainer = document.createElement('div');
    linkContainer.style.padding = '8px';
    linkContainer.style.fontSize = '12px';
    linkContainer.innerHTML = `
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

    folder.on('fold', (ev) => {
      this.accordionStates[`cat_${categoryId}`] = ev.expanded;
      this.saveUIState();
    });

    this.categoryFolders[categoryId] = folder;
    return folder;
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
        atmospheric: 'Atmospheric & Environmental',
        surface: 'Surface & Material',
        water: 'Water',
        structure: 'Objects & Structures',
        particle: 'Particles & VFX',
        global: 'Global & Post'
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

          for (const [paramId, value] of Object.entries(presetDef)) {
            const paramDef = schema.parameters?.[paramId];
            if (!paramDef) continue;

            const result = globalValidator.validateParameter(paramId, value, paramDef);
            const finalValue = result.valid ? result.value : paramDef.default;

            effectData.params[paramId] = finalValue;

            if (effectData.bindings[paramId]) {
              effectData.bindings[paramId].refresh();
            }

            const callback = this.effectCallbacks.get(effectId) || updateCallback;
            if (callback) {
              callback(effectId, paramId, finalValue);
            }
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

    enableBinding.on('change', this.throttle((ev) => {
      this.markDirty(effectId, 'enabled');
      updateCallback(effectId, 'enabled', ev.value);
      this.updateEffectiveState(effectId);
      this.updateControlStates(effectId);
      this.queueSave(effectId);
    }, 100));

    // Build controls from schema
    this.buildEffectControls(effectId, folder, schema, updateCallback, validatedParams);

    // Push initial parameter values into the effect so it starts in sync
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

    // Throttled change handler with validation
    const throttleTime = paramDef.throttle || 100; // Default 100ms
    binding.on('change', this.throttle((ev) => {
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
      
      // Use validated value
      const validValue = validation.value;
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
    }, throttleTime));
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
      let params = {};
      if (allSettings.mapMaker?.effects?.[effectId]) {
        params = { ...allSettings.mapMaker.effects[effectId] };
      }

      // Apply GM overrides if in GM mode and overrides exist
      if (this.settingsMode === 'gm' && allSettings.gm?.effects?.[effectId]) {
        params = { ...params, ...allSettings.gm.effects[effectId] };
      }

      // Apply player overrides (client-local, disable only)
      if (!game.user.isGM) {
        const playerOverrides = game.settings.get('map-shine-advanced', `scene-${scene.id}-player-overrides`) || {};
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
      const params = { ...effectData.params };

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
        const playerOverrides = game.settings.get('map-shine-advanced', `scene-${scene.id}-player-overrides`) || {};
        playerOverrides[effectId] = params.enabled;
        await game.settings.set('map-shine-advanced', `scene-${scene.id}-player-overrides`, playerOverrides);
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
    const effectData = this.effectFolders[effectId];
    if (!effectData) {
      log.error(`Cannot reset ${effectId}: effect not registered`);
      return;
    }

    log.info(`Resetting ${effectId} to defaults`);

    // Reset all parameters to schema defaults
    for (const [paramId, paramDef] of Object.entries(effectData.schema.parameters || {})) {
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

    ui.notifications.info(`Map Shine: ${effectId} reset to defaults`);
  }

  /**
   * Run sanity check on an effect's current parameters
   * Detects invalid parameter combinations and warns/auto-fixes
   * @param {string} effectId - Effect to check
   * @private
   */
  runSanityCheck(effectId) {
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
    } else {
      return; // No dependencies for other effects yet
    }
    
    // Update each binding's disabled state
    for (const [paramId, config] of Object.entries(effectData.bindingConfigs)) {
      const { binding } = config;
      
      // Determine if this control should be disabled
      let shouldDisable = false;
      let isProblemControl = false;
      
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

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
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
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      
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
        Object.assign(this.globalParams, state.globalParams);
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
   * Save UI state to client settings
   * @private
   */
  async saveUIState() {
    try {
      const rect = this.container.getBoundingClientRect();
      
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

  log.info('UI settings registered');
}
