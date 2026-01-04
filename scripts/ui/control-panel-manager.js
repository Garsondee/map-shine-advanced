/**
 * @fileoverview Control Panel Manager - GM live-play interface
 * Compact Tweakpane-based UI for time-of-day and weather control during actual play
 * @module ui/control-panel-manager
 */

import { createLogger } from '../core/log.js';
import { stateApplier } from './state-applier.js';
import { weatherController as coreWeatherController } from '../core/WeatherController.js';

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
    
    /** @type {Object} Runtime control state (saved to scene flags) */
    this.controlState = {
      timeOfDay: 12.0,
      weatherMode: 'dynamic', // 'dynamic' | 'directed'
      // Dynamic mode
      dynamicEnabled: false,
      dynamicPresetId: 'Temperate Plains',
      dynamicEvolutionSpeed: 60.0,
      dynamicPaused: false,
      // Directed mode
      directedPresetId: 'Clear (Dry)',
      directedTransitionMinutes: 5.0
    };

    this._suppressInitialWeatherApply = false;
    
    /** @type {Object} Cached DOM elements for clock */
    this.clockElements = {};
    
    /** @type {Function} Debounced save function */
    this.debouncedSave = this._debounce(() => this._saveControlState(), 500);

    /** @type {HTMLElement|null} */
    this.statusPanel = null;

    /** @type {HTMLElement|null} */
    this.headerOverlay = null;

    /** @type {boolean} */
    this._isDraggingPanel = false;

    /** @type {{mx:number,my:number,left:number,top:number}|null} */
    this._dragStart = null;

    /** @type {number|null} */
    this._statusIntervalId = null;

    /** @type {boolean} */
    this._didLoadControlState = false;

    this._boundHandlers = {
      onFaceMouseDown: (e) => this._onClockMouseDown(e),
      onFaceTouchStart: (e) => this._onClockTouchStart(e),
      onDocMouseMove: (e) => this._onClockMouseMove(e),
      onDocMouseUp: () => this._onClockMouseUp(),
      onDocTouchMove: (e) => this._onClockTouchMove(e),
      onDocTouchEnd: () => this._onClockMouseUp(),
      onHeaderMouseDown: (e) => this._onHeaderMouseDown(e),
      onDocPanelMouseMove: (e) => this._onHeaderMouseMove(e),
      onDocPanelMouseUp: () => this._onHeaderMouseUp()
    };
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
      `;
      document.head.appendChild(style);
    }

    const panel = document.createElement('div');
    panel.style.padding = '10px 12px';
    panel.style.margin = '6px';
    panel.style.borderRadius = '8px';
    panel.style.background = 'rgba(0,0,0,0.25)';
    panel.style.border = '1px solid rgba(255,255,255,0.10)';
    panel.style.fontFamily = 'system-ui, -apple-system, Segoe UI, sans-serif';
    panel.style.fontSize = '13px';
    panel.style.lineHeight = '1.35';

    const title = document.createElement('div');
    title.textContent = 'Weather Status';
    title.style.fontWeight = '600';
    title.style.marginBottom = '6px';
    panel.appendChild(title);

    const modeLine = document.createElement('div');
    modeLine.style.display = 'flex';
    modeLine.style.justifyContent = 'space-between';
    modeLine.style.gap = '10px';
    modeLine.style.opacity = '0.92';
    modeLine.style.marginBottom = '8px';
    panel.appendChild(modeLine);

    const modeText = document.createElement('div');
    const activityText = document.createElement('div');
    activityText.style.opacity = '0.85';
    modeLine.appendChild(modeText);
    modeLine.appendChild(activityText);

    const row = document.createElement('div');
    row.style.display = 'grid';
    row.style.gridTemplateColumns = '1fr 1fr';
    row.style.gap = '10px';

    const cur = document.createElement('div');
    const tgt = document.createElement('div');

    const curLabel = document.createElement('div');
    curLabel.textContent = 'Now';
    curLabel.style.opacity = '0.8';
    curLabel.style.marginBottom = '2px';

    const tgtLabel = document.createElement('div');
    tgtLabel.textContent = 'Target';
    tgtLabel.style.opacity = '0.8';
    tgtLabel.style.marginBottom = '2px';

    const curText = document.createElement('div');
    const tgtText = document.createElement('div');
    curText.style.whiteSpace = 'pre-line';
    tgtText.style.whiteSpace = 'pre-line';

    cur.appendChild(curLabel);
    cur.appendChild(curText);
    tgt.appendChild(tgtLabel);
    tgt.appendChild(tgtText);
    row.appendChild(cur);
    row.appendChild(tgt);
    panel.appendChild(row);

    const progressWrap = document.createElement('div');
    progressWrap.style.marginTop = '8px';

    const progressMeta = document.createElement('div');
    progressMeta.style.display = 'flex';
    progressMeta.style.justifyContent = 'space-between';
    progressMeta.style.gap = '8px';
    progressMeta.style.opacity = '0.9';

    const progressLabel = document.createElement('div');
    const progressPct = document.createElement('div');

    progressMeta.appendChild(progressLabel);
    progressMeta.appendChild(progressPct);

    const barOuter = document.createElement('div');
    barOuter.style.height = '8px';
    barOuter.style.borderRadius = '999px';
    barOuter.style.background = 'rgba(255,255,255,0.10)';
    barOuter.style.overflow = 'hidden';
    barOuter.style.marginTop = '4px';

    const barInner = document.createElement('div');
    barInner.style.height = '100%';
    barInner.style.width = '0%';
    barInner.style.background = 'rgba(80, 200, 255, 0.85)';
    barInner.style.transition = 'width 120ms linear';
    barOuter.appendChild(barInner);

    progressWrap.appendChild(progressMeta);
    progressWrap.appendChild(barOuter);
    panel.appendChild(progressWrap);

    this.statusPanel = panel;
    this._statusEls = { curText, tgtText, modeText, activityText, progressLabel, progressPct, barInner, progressWrap };

    // Insert directly under the pane title bar.
    const root = this.pane.element;
    root.insertBefore(panel, root.firstChild?.nextSibling ?? root.firstChild);

    this._updateStatusPanel();
  }

  _formatWeatherLine(state) {
    if (!state) return '—';
    const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`;
    const freeze = Math.max(0, Math.min(1, Number(state.freezeLevel) || 0));
    const tempLabel = freeze > 0.75 ? 'Snow' : (freeze > 0.45 ? 'Sleet' : 'Rain');
    return [
      `Precipitation: ${pct(state.precipitation)}`,
      `Humidity (Clouds): ${pct(state.cloudCover)}`,
      `Wind Strength: ${pct(state.windSpeed)}`,
      `Fog: ${pct(state.fogDensity)}`,
      `Temperature: ${Math.round(freeze * 100)}% (${tempLabel})`
    ].join('\n');
  }

  _updateStatusPanel() {
    const els = this._statusEls;
    if (!els) return;

    const wc = coreWeatherController || window.MapShine?.weatherController || window.weatherController;
    if (!wc) {
      els.modeText.textContent = 'Weather: Unavailable';
      els.activityText.textContent = '';
      els.curText.textContent = 'WeatherController not available';
      els.tgtText.textContent = '—';
      els.progressWrap.style.display = 'none';
      return;
    }

    const isEnabled = wc.enabled !== false;
    const isDynamic = wc.dynamicEnabled === true;
    const isPaused = wc.dynamicPaused === true;
    const isTrans = wc.isTransitioning === true && Number(wc.transitionDuration) > 0;

    const dynamicPreset = typeof wc.dynamicPresetId === 'string' && wc.dynamicPresetId ? wc.dynamicPresetId : '—';
    const dynamicSpeed = Number.isFinite(wc.dynamicEvolutionSpeed) ? wc.dynamicEvolutionSpeed : null;

    let modeLabel = 'Weather: Directed';
    if (!isEnabled) {
      modeLabel = 'Weather: Disabled';
    } else if (isDynamic) {
      if (isPaused) modeLabel = `Weather: Dynamic (Paused)`;
      else if (isTrans) modeLabel = `Weather: Dynamic (Transitioning)`;
      else modeLabel = `Weather: Dynamic (Running)`;
    }
    els.modeText.textContent = modeLabel;

    if (isEnabled && isDynamic) {
      const spd = dynamicSpeed !== null ? `, Speed ${Math.round(dynamicSpeed)}x` : '';
      els.activityText.textContent = `${dynamicPreset}${spd}`;
    } else {
      els.activityText.textContent = '';
    }

    const cur = wc.getCurrentState?.() ?? wc.currentState;
    const tgt = wc.targetState;
    els.curText.textContent = this._formatWeatherLine(cur);
    els.tgtText.textContent = this._formatWeatherLine(tgt);

    if (!isEnabled) {
      els.progressWrap.style.display = 'none';
      els.barInner.style.animation = 'none';
      els.barInner.style.width = '0%';
      return;
    }

    if (isTrans) {
      const dur = Math.max(0.0001, Number(wc.transitionDuration) || 0);
      const el = Math.max(0, Number(wc.transitionElapsed) || 0);
      const t = Math.max(0, Math.min(1, el / dur));
      const eta = Math.max(0, dur - el);

      els.progressWrap.style.display = 'block';
      els.progressLabel.textContent = `Transitioning (${eta.toFixed(1)}s)`;
      els.progressPct.textContent = `${Math.round(t * 100)}%`;
      els.barInner.style.animation = 'none';
      els.barInner.style.width = `${t * 100}%`;
      return;
    }

    if (isDynamic) {
      els.progressWrap.style.display = 'block';
      els.progressLabel.textContent = isPaused ? 'Dynamic: Paused' : 'Dynamic: Running';
      els.progressPct.textContent = '';
      els.barInner.style.width = '35%';
      els.barInner.style.animation = isPaused ? 'none' : 'mapShineIndeterminate 1.15s linear infinite';
      return;
    }

    els.progressWrap.style.display = 'none';
    els.barInner.style.animation = 'none';
    els.barInner.style.width = '0%';
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

    // Wait for Tweakpane to be available
    const startTime = Date.now();
    while (typeof Tweakpane === 'undefined' && (Date.now() - startTime) < 5000) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (typeof Tweakpane === 'undefined') {
      throw new Error('Tweakpane library not available');
    }

    log.info('Initializing Control Panel...');

    // Create container
    this.container = document.createElement('div');
    this.container.id = 'map-shine-control-panel';
    this.container.style.position = 'fixed';
    this.container.style.zIndex = '9999'; // Below config panel (10000)
    this.container.style.left = '50%';
    this.container.style.top = '50%';
    this.container.style.transform = 'translate(-50%, -50%)';
    this.container.style.display = 'none'; // Initially hidden
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
        'pointerup',
        'pointermove',
        'mousedown',
        'mouseup',
        'mousemove',
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

    this._buildStatusPanel();

    // Load saved control state
    this._didLoadControlState = await this._loadControlState();

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
    this._buildTimeSection();
    this._buildWeatherSection();
    this._buildUtilitiesSection();

    // Apply initial state
    await this._applyControlState();

    log.info('Control Panel initialized');
  }

  /**
   * Build the Time of Day section with custom clock
   * @private
   */
  _buildTimeSection() {
    const timeFolder = this.pane.addFolder({
      title: '⏰ Time of Day',
      expanded: true
    });

    // Create custom clock DOM
    this.clockElement = this._createClockDOM();
    const contentElement = timeFolder.element.querySelector('.tp-fldv_c') || timeFolder.element;
    contentElement.appendChild(this.clockElement);

    // Quick time buttons
    const quickTimes = {
      'Dawn': 6.0,
      'Noon': 12.0,
      'Dusk': 18.0,
      'Midnight': 0.0
    };

    const btnGrid = document.createElement('div');
    btnGrid.style.display = 'grid';
    btnGrid.style.gridTemplateColumns = '1fr 1fr';
    btnGrid.style.gap = '6px';
    btnGrid.style.margin = '8px auto 0';
    btnGrid.style.width = '200px';

    for (const [label, hour] of Object.entries(quickTimes)) {
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
        void this._setTimeOfDay(hour).then(() => this.debouncedSave());
      });
      btnGrid.appendChild(btn);
    }

    contentElement.appendChild(btnGrid);
  }

  /**
   * Create custom clock DOM element
   * @returns {HTMLElement}
   * @private
   */
  _createClockDOM() {
    const container = document.createElement('div');
    container.style.cssText = `
      width: 200px;
      height: 210px;
      position: relative;
      margin: 10px auto;
    `;

    // Clock face
    const face = document.createElement('div');
    const modulePath = game?.modules?.get?.('map-shine-advanced')?.path;
    const clockBg = modulePath ? `${modulePath}/assets/clock-face.webp` : null;
    face.style.cssText = `
      width: 180px;
      height: 180px;
      border: 3px solid #444;
      border-radius: 50%;
      position: relative;
      background: ${clockBg ? `url('${clockBg}') center/cover` : 'none'};
      margin: 0 auto;
      cursor: crosshair;
    `;

    // Hour markers (24-hour)
    // Noon (12) is at the top, midnight (0) is at the bottom.
    for (let i = 0; i < 24; i++) {
      const marker = document.createElement('div');
      const isMajor = i % 6 === 0;
      const shifted = ((i - 12) % 24 + 24) % 24;
      const deg = shifted * 15;
      const angle = (deg - 90) * (Math.PI / 180);
      const r1 = isMajor ? 72 : 76;
      const r2 = 82;
      const x1 = 85 + Math.cos(angle) * r1;
      const y1 = 85 + Math.sin(angle) * r1;
      const x2 = 85 + Math.cos(angle) * r2;
      const y2 = 85 + Math.sin(angle) * r2;
      
      marker.style.cssText = `
        position: absolute;
        width: ${isMajor ? 3 : 2}px;
        height: ${isMajor ? 10 : 6}px;
        background: ${isMajor ? '#222' : '#333'};
        left: ${x1}px;
        top: ${y1}px;
        transform: rotate(${deg}deg);
        transform-origin: ${isMajor ? 1.5 : 1}px ${isMajor ? 5 : 3}px;
      `;
      face.appendChild(marker);
    }

    // Clock hand
    const hand = document.createElement('div');
    hand.style.cssText = `
      position: absolute;
      width: 3px;
      height: 70px;
      background: #e74c3c;
      left: 88px;
      top: 15px;
      transform-origin: 1.5px 75px;
      border-radius: 2px;
      box-shadow: 0 0 4px rgba(0,0,0,0.3);
      pointer-events: none;
    `;

    // Center dot
    const center = document.createElement('div');
    center.style.cssText = `
      position: absolute;
      width: 12px;
      height: 12px;
      background: #2c3e50;
      border-radius: 50%;
      left: 84px;
      top: 84px;
      z-index: 2;
    `;

    // Digital time display
    const digital = document.createElement('div');
    digital.style.cssText = `
      text-align: center;
      font-family: monospace;
      font-size: 16px;
      font-weight: bold;
      color: #2c3e50;
      margin-top: 10px;
    `;

    face.appendChild(hand);
    face.appendChild(center);
    container.appendChild(face);
    container.appendChild(digital);

    // Store references
    this.clockElements = { hand, digital, face };

    // Mouse events for dragging
    face.addEventListener('mousedown', this._boundHandlers.onFaceMouseDown);
    document.addEventListener('mousemove', this._boundHandlers.onDocMouseMove, { capture: true });
    document.addEventListener('mouseup', this._boundHandlers.onDocMouseUp, { capture: true });

    // Touch events for mobile
    face.addEventListener('touchstart', this._boundHandlers.onFaceTouchStart);
    document.addEventListener('touchmove', this._boundHandlers.onDocTouchMove);
    document.addEventListener('touchend', this._boundHandlers.onDocTouchEnd);

    return container;
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
      this.debouncedSave();
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
    
    void this._setTimeOfDay(hour24);
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
  }

  /**
   * Set time of day and update UI using centralized StateApplier
   * @param {number} hour - 0-24 hour value
   * @private
   */
  async _setTimeOfDay(hour) {
    this.controlState.timeOfDay = hour % 24;
    this._updateClock(hour);
    await this._applyControlState();
  }

  /**
   * Build the Weather section
   * @private
   */
  _buildWeatherSection() {
    const weatherFolder = this.pane.addFolder({
      title: '🌦️ Weather',
      expanded: true
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

      this._updateWeatherControls(weatherFolder);
      void this._applyControlState();
      this.debouncedSave();
    });

    // Dynamic mode controls (initially visible)
    this.dynamicControls = this._buildDynamicControls(weatherFolder);
    
    // Directed mode controls (initially hidden)
    this.directedControls = this._buildDirectedControls(weatherFolder);

    // Show/hide appropriate controls based on current mode
    this._updateWeatherControls(weatherFolder);
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
   * Update visibility of weather controls based on mode
   * @param {Tweakpane.Folder} weatherFolder
   * @private
   */
  _updateWeatherControls(weatherFolder) {
    const isDynamic = this.controlState.weatherMode === 'dynamic';
    
    // Show/hide dynamic controls
    Object.values(this.dynamicControls).forEach(control => {
      control.hidden = !isDynamic;
    });
    
    // Show/hide directed controls
    Object.values(this.directedControls).forEach(control => {
      control.hidden = isDynamic;
    });
  }

  /**
   * Build utilities section
   * @private
   */
  _buildUtilitiesSection() {
    const utilsFolder = this.pane.addFolder({
      title: '⚙️ Utilities',
      expanded: false
    });

    utilsFolder.addButton({
      title: 'Reset to Defaults'
    }).on('click', () => {
      this._resetToDefaults();
    });

    utilsFolder.addButton({
      title: 'Copy Current Weather'
    }).on('click', () => {
      this._copyCurrentWeather();
    });
  }

  /**
   * Apply control state to game systems using centralized StateApplier
   * @private
   */
  async _applyControlState() {
    try {
      // Apply time of day using centralized logic
      await stateApplier.applyTimeOfDay(this.controlState.timeOfDay, false); // Don't save here, handled by debouncedSave

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

      log.debug('Applied control state via StateApplier:', this.controlState);
    } catch (error) {
      log.error('Failed to apply control state:', error);
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
      weatherMode: 'dynamic',
      dynamicEnabled: false,
      dynamicPresetId: 'Temperate Plains',
      dynamicEvolutionSpeed: 60.0,
      dynamicPaused: false,
      directedPresetId: 'Clear (Dry)',
      directedTransitionMinutes: 5.0
    };

    this._updateClock(12.0);
    void this._applyControlState().then(() => this._saveControlState());
    
    // Refresh bindings
    if (this.pane) {
      this.pane.refresh();
    }

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

      const weatherText = `
Current Weather:
- Precipitation: ${(state.precipitation * 100).toFixed(0)}%
- Cloud Cover: ${(state.cloudCover * 100).toFixed(0)}%
- Wind Speed: ${(state.windSpeed * 100).toFixed(0)}%
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
        log.info('Loaded control state from scene flags');
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

      await scene.setFlag('map-shine-advanced', 'controlState', this.controlState);
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
    
    this.container.style.display = 'block';
    this.visible = true;
    
    // Update clock to current state
    this._updateClock(this.controlState.timeOfDay);

    // Ensure status panel is up to date immediately.
    this._updateStatusPanel();

    // Start status updates
    if (this._statusIntervalId) clearInterval(this._statusIntervalId);
    this._statusIntervalId = setInterval(() => {
      try {
        this._updateStatusPanel();
      } catch (e) {
      }
    }, 250);
    
    log.debug('Control panel shown');
  }

  /**
   * Hide the control panel
   */
  hide() {
    if (!this.container) return;
    
    this.container.style.display = 'none';
    this.visible = false;

    if (this._statusIntervalId) {
      clearInterval(this._statusIntervalId);
      this._statusIntervalId = null;
    }
    
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

    log.info('Control panel destroyed');
  }
}
