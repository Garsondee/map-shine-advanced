/**
 * @fileoverview Enhanced Light Inspector UI
 * Lightweight overlay panel for editing MapShine enhanced light properties
 * @module ui/enhanced-light-inspector
 */

import { createLogger } from '../core/log.js';

const log = createLogger('EnhancedLightInspector');

/**
 * Inspector UI for MapShine enhanced lights
 * Shows when a light is selected, allows editing properties
 */
export class EnhancedLightInspector {
  constructor() {
    /** @type {HTMLElement|null} */
    this.container = null;

    /** @type {string|null} Currently inspected light ID */
    this.currentLightId = null;

    /** @type {Object|null} Current light data */
    this.currentLightData = null;

    /** @type {boolean} */
    this.visible = false;

    /** @type {Object} Input elements */
    this.inputs = {};

    /** @type {number|null} Debounce timeout for updates */
    this.updateTimeout = null;
  }

  /**
   * Initialize the inspector UI
   */
  initialize() {
    this.createUI();
    log.info('Enhanced Light Inspector initialized');
  }

  /**
   * Create the inspector UI elements
   * @private
   */
  createUI() {
    // Create container
    this.container = document.createElement('div');
    this.container.id = 'mapshine-light-inspector';
    this.container.style.cssText = `
      position: fixed;
      top: 120px;
      right: 20px;
      width: 280px;
      background: rgba(30, 30, 35, 0.95);
      border: 1px solid rgba(100, 100, 120, 0.5);
      border-radius: 6px;
      padding: 12px;
      font-family: 'Signika', sans-serif;
      font-size: 13px;
      color: #e0e0e0;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6);
      z-index: 10001;
      display: none;
      pointer-events: auto;
    `;

    // Header
    const header = document.createElement('div');
    header.style.cssText = `
      font-weight: bold;
      font-size: 14px;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(100, 100, 120, 0.3);
      color: #44aaff;
      display: flex;
      justify-content: space-between;
      align-items: center;
    `;
    header.innerHTML = `
      <span>MapShine Light</span>
      <button id="mapshine-light-inspector-close" style="
        background: none;
        border: none;
        color: #aaa;
        cursor: pointer;
        font-size: 16px;
        padding: 0;
        width: 20px;
        height: 20px;
      ">×</button>
    `;
    this.container.appendChild(header);

    // Position section
    this.addSection('Position', [
      { label: 'X', key: 'x', type: 'number', step: 10 },
      { label: 'Y', key: 'y', type: 'number', step: 10 }
    ]);

    // Photometry section
    this.addSection('Photometry', [
      { label: 'Bright Radius', key: 'bright', type: 'number', min: 0, step: 1 },
      { label: 'Dim Radius', key: 'dim', type: 'number', min: 0, step: 1 },
      { label: 'Alpha', key: 'alpha', type: 'number', min: 0, max: 1, step: 0.1 },
      { label: 'Luminosity', key: 'luminosity', type: 'number', min: 0, max: 1, step: 0.1 },
      { label: 'Attenuation', key: 'attenuation', type: 'number', min: 0, max: 1, step: 0.1 }
    ]);

    // Color section
    this.addSection('Color', [
      { label: 'Color', key: 'color', type: 'color' }
    ]);

    // Cookie section
    this.addSection('Cookie/Gobo', [
      { label: 'Texture Path', key: 'cookieTexture', type: 'text', placeholder: 'path/to/texture.webp' },
      { label: 'Rotation', key: 'cookieRotation', type: 'number', min: 0, max: 360, step: 15 },
      { label: 'Scale', key: 'cookieScale', type: 'number', min: 0.1, max: 5, step: 0.1 }
    ]);

    // Target Layers section
    this.addSection('Target Layers', [
      { label: 'Layers', key: 'targetLayers', type: 'select', options: [
        { value: 'ground', label: 'Ground Only' },
        { value: 'overhead', label: 'Overhead Only' },
        { value: 'both', label: 'Both' }
      ]}
    ]);

    // State section
    this.addSection('State', [
      { label: 'Enabled', key: 'enabled', type: 'checkbox' },
      { label: 'Darkness', key: 'isDarkness', type: 'checkbox' }
    ]);

    // Close button handler
    const closeBtn = this.container.querySelector('#mapshine-light-inspector-close');
    closeBtn.addEventListener('click', () => this.hide());

    document.body.appendChild(this.container);
  }

  /**
   * Add a section to the inspector
   * @private
   */
  addSection(title, fields) {
    const section = document.createElement('div');
    section.style.cssText = 'margin-bottom: 12px;';

    const sectionTitle = document.createElement('div');
    sectionTitle.textContent = title;
    sectionTitle.style.cssText = `
      font-weight: 600;
      font-size: 12px;
      color: #aaa;
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    `;
    section.appendChild(sectionTitle);

    for (const field of fields) {
      const row = document.createElement('div');
      row.style.cssText = 'margin-bottom: 6px; display: flex; align-items: center; gap: 8px;';

      const label = document.createElement('label');
      label.textContent = field.label;
      label.style.cssText = 'flex: 0 0 100px; font-size: 12px; color: #ccc;';
      row.appendChild(label);

      let input;
      if (field.type === 'select') {
        input = document.createElement('select');
        input.style.cssText = `
          flex: 1;
          background: rgba(50, 50, 60, 0.8);
          border: 1px solid rgba(100, 100, 120, 0.5);
          border-radius: 3px;
          padding: 4px 6px;
          color: #e0e0e0;
          font-size: 12px;
        `;
        for (const opt of field.options) {
          const option = document.createElement('option');
          option.value = opt.value;
          option.textContent = opt.label;
          input.appendChild(option);
        }
      } else if (field.type === 'checkbox') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.style.cssText = 'width: 16px; height: 16px;';
      } else {
        input = document.createElement('input');
        input.type = field.type;
        input.style.cssText = `
          flex: 1;
          background: rgba(50, 50, 60, 0.8);
          border: 1px solid rgba(100, 100, 120, 0.5);
          border-radius: 3px;
          padding: 4px 6px;
          color: #e0e0e0;
          font-size: 12px;
        `;
        if (field.min !== undefined) input.min = field.min;
        if (field.max !== undefined) input.max = field.max;
        if (field.step !== undefined) input.step = field.step;
        if (field.placeholder) input.placeholder = field.placeholder;
      }

      input.addEventListener('input', () => this.onInputChange(field.key, input));
      this.inputs[field.key] = input;

      row.appendChild(input);
      section.appendChild(row);
    }

    this.container.appendChild(section);
  }

  /**
   * Handle input change
   * @private
   */
  onInputChange(key, input) {
    if (!this.currentLightId) return;

    // Debounce updates
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
    }

    this.updateTimeout = setTimeout(() => {
      this.applyUpdate(key, input);
    }, 300);
  }

  /**
   * Apply update to the light
   * @private
   */
  async applyUpdate(key, input) {
    if (!this.currentLightId) return;

    const enhancedLightsApi = window.MapShine?.enhancedLights;
    if (!enhancedLightsApi) {
      log.error('MapShine.enhancedLights API not available');
      return;
    }

    let value;
    if (input.type === 'checkbox') {
      value = input.checked;
    } else if (input.type === 'number') {
      value = parseFloat(input.value);
      if (isNaN(value)) return;
    } else {
      value = input.value;
    }

    // Build update object based on key
    const update = {};
    if (key === 'x' || key === 'y') {
      update.transform = { ...this.currentLightData.transform, [key]: value };
    } else if (['bright', 'dim', 'alpha', 'luminosity', 'attenuation'].includes(key)) {
      update.photometry = { ...this.currentLightData.photometry, [key]: value };
    } else if (key === 'color') {
      update.color = value;
    } else if (['cookieTexture', 'cookieRotation', 'cookieScale'].includes(key)) {
      update[key] = value;
    } else if (key === 'targetLayers') {
      update.targetLayers = value;
    } else if (key === 'enabled' || key === 'isDarkness') {
      update[key] = value;
    }

    try {
      await enhancedLightsApi.update(this.currentLightId, update);
      log.debug(`Updated light ${this.currentLightId}: ${key} = ${value}`);
    } catch (err) {
      log.error(`Failed to update light ${this.currentLightId}`, err);
      ui.notifications?.error?.('Failed to update light');
    }
  }

  /**
   * Show inspector for a light
   * @param {string} lightId - Light ID
   */
  async show(lightId) {
    const enhancedLightsApi = window.MapShine?.enhancedLights;
    if (!enhancedLightsApi) {
      log.error('MapShine.enhancedLights API not available');
      return;
    }

    try {
      const lightData = await enhancedLightsApi.get(lightId);
      if (!lightData) {
        log.warn(`Light ${lightId} not found`);
        return;
      }

      this.currentLightId = lightId;
      this.currentLightData = lightData;
      this.populateInputs(lightData);
      this.container.style.display = 'block';
      this.visible = true;
    } catch (err) {
      log.error(`Failed to load light ${lightId}`, err);
    }
  }

  /**
   * Populate inputs with light data
   * @private
   */
  populateInputs(lightData) {
    // Position
    if (this.inputs.x) this.inputs.x.value = lightData.transform?.x ?? 0;
    if (this.inputs.y) this.inputs.y.value = lightData.transform?.y ?? 0;

    // Photometry
    if (this.inputs.bright) this.inputs.bright.value = lightData.photometry?.bright ?? 0;
    if (this.inputs.dim) this.inputs.dim.value = lightData.photometry?.dim ?? 0;
    if (this.inputs.alpha) this.inputs.alpha.value = lightData.photometry?.alpha ?? 1;
    if (this.inputs.luminosity) this.inputs.luminosity.value = lightData.photometry?.luminosity ?? 0.5;
    if (this.inputs.attenuation) this.inputs.attenuation.value = lightData.photometry?.attenuation ?? 0.5;

    // Color
    if (this.inputs.color) this.inputs.color.value = lightData.color ?? '#ffffff';

    // Cookie
    if (this.inputs.cookieTexture) this.inputs.cookieTexture.value = lightData.cookieTexture ?? '';
    if (this.inputs.cookieRotation) this.inputs.cookieRotation.value = lightData.cookieRotation ?? 0;
    if (this.inputs.cookieScale) this.inputs.cookieScale.value = lightData.cookieScale ?? 1;

    // Target Layers
    if (this.inputs.targetLayers) this.inputs.targetLayers.value = lightData.targetLayers ?? 'both';

    // State
    if (this.inputs.enabled) this.inputs.enabled.checked = lightData.enabled ?? true;
    if (this.inputs.isDarkness) this.inputs.isDarkness.checked = lightData.isDarkness ?? false;
  }

  /**
   * Hide inspector
   */
  hide() {
    this.container.style.display = 'none';
    this.visible = false;
    this.currentLightId = null;
    this.currentLightData = null;
  }

  /**
   * Dispose the inspector
   */
  dispose() {
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
    this.inputs = {};
    this.currentLightId = null;
    this.currentLightData = null;
  }
}
