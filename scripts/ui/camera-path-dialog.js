/**
 * @fileoverview Camera Path dialog — cinematic camera sweeps from Quick Actions.
 *
 * @module ui/camera-path-dialog
 */
import { createLogger } from '../core/log.js';
import {
  CAMERA_PATH_POINT_KEYS,
  CAMERA_PATH_PRESET_OPTIONS,
} from '../foundry/camera-path-generator.js';
import { ENVIRONMENT_OVERRIDE_SPECS, normalizeEnvironmentSnapshot } from './environment-override-specs.js';
import { environmentControlApi } from './environment-control-api.js';

const log = createLogger('CameraPathDialog');

/**
 * @param {number} hour
 * @returns {string}
 */
function formatTimeOfDayLabel(hour) {
  const h = ((Number(hour) % 24) + 24) % 24;
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60) % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * @param {number} seconds
 * @returns {string}
 */
function formatDurationHuman(seconds) {
  const sec = Math.max(0, Math.round(Number(seconds) || 0));
  if (sec <= 0) return '—';
  if (sec < 60) return `${sec} sec`;

  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  if (rem === 0) return `${mins} min`;
  return `${mins} min ${rem} sec`;
}

/**
 * @param {string} value
 */
function escapeHtml(value) {
  const s = String(value ?? '');
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class CameraPathDialog {
  /**
   * @param {import('../foundry/camera-path-service.js').CameraPathService} service
   */
  constructor(service) {
    /** @type {import('../foundry/camera-path-service.js').CameraPathService} */
    this.service = service;

    /** @type {HTMLElement|null} */
    this.container = null;

    /** @type {boolean} */
    this.visible = false;

    /** @type {string|null} */
    this._selectedSigLocId = null;

    /** @type {{ id: string, host: HTMLElement }|null} */
    this._sigLocDrag = null;
  }

  initialize(parentElement = document.body) {
    if (this.container) return;

    const container = document.createElement('div');
    container.id = 'map-shine-camera-path';
    container.className = 'map-shine-camera-path map-shine-overlay-ui';
    container.style.display = 'none';

    const presetOptions = CAMERA_PATH_PRESET_OPTIONS
      .map((opt) => `<option value="${escapeHtml(opt.id)}">${escapeHtml(opt.label)}</option>`)
      .join('');

    container.innerHTML = `
      <div class="msa-cpath__header" data-drag-handle>
        <div class="msa-cpath__title">Camera Path</div>
        <div class="msa-cpath__status" data-bind="status">Ready</div>
        <button type="button" class="msa-cpath__close" data-action="close" aria-label="Close">×</button>
      </div>

      <div class="msa-cpath__body">
        <section class="msa-cpath__timeline-band">
          <div class="msa-cpath__card-head">
            <h3 class="msa-cpath__section-title">Timeline</h3>
            <span class="msa-cpath__timeline-total" data-bind="timelineTotal">—</span>
          </div>
          <div class="msa-cpath__timeline-ruler" data-bind="timelineRuler"></div>
          <div class="msa-cpath__timeline-scroll">
            <div class="msa-cpath__timeline-track" data-bind="timeline"></div>
          </div>
          <p class="msa-cpath__hint msa-cpath__hint--tight msa-cpath__timeline-warn" data-bind="timelineWarn" hidden></p>
        </section>

        <div class="msa-cpath__columns">
          <div class="msa-cpath__col msa-cpath__col--path">
            <section class="msa-cpath__card">
              <h3 class="msa-cpath__section-title">Auto-Generate</h3>
              <p class="msa-cpath__hint">Calculates zoom from your monitor resolution to frame the map.</p>
              <div class="msa-cpath__row">
                <select class="msa-cpath__select" data-input="preset">${presetOptions}</select>
                <button type="button" class="msa-cpath__btn" data-action="generate">Generate</button>
              </div>
            </section>

            <section class="msa-cpath__card">
              <div class="msa-cpath__card-head">
                <h3 class="msa-cpath__section-title">Significant Locations</h3>
                <button type="button" class="msa-cpath__btn msa-cpath__btn--small" data-action="record-sig-loc">Record location</button>
              </div>
              <p class="msa-cpath__hint">Named views the camera pauses on during playback. Drag to set priority; pin placement below.</p>
              <div class="msa-cpath__sig-settings">
                <label class="msa-cpath__field">
                  <span>Default hold (sec)</span>
                  <input type="number" min="0.5" step="0.5" data-input="defaultSigHoldSec">
                </label>
                <label class="msa-cpath__field">
                  <span>Transition pan (sec)</span>
                  <input type="number" min="0" step="0.5" data-input="sigTransitionSec">
                </label>
              </div>
              <div class="msa-cpath__sig-list" data-bind="sigLocs"></div>
            </section>

            <section class="msa-cpath__card msa-cpath__card--grow">
              <div class="msa-cpath__card-head">
                <h3 class="msa-cpath__section-title">Path Editor</h3>
                <p class="msa-cpath__hint msa-cpath__hint--inline">Empty points are skipped. Valid input live-previews on the canvas.</p>
              </div>
              <div class="msa-cpath__points-scroll">
                <table class="msa-cpath__points-table">
                  <thead>
                    <tr>
                      <th scope="col">Point</th>
                      <th scope="col">X</th>
                      <th scope="col">Y</th>
                      <th scope="col">Zoom</th>
                      <th scope="col" class="msa-cpath__th-actions">Camera</th>
                    </tr>
                  </thead>
                  <tbody class="msa-cpath__points" data-bind="points"></tbody>
                </table>
              </div>
            </section>
          </div>

          <div class="msa-cpath__col msa-cpath__col--config">
            <section class="msa-cpath__card">
              <h3 class="msa-cpath__section-title">Playback</h3>
              <div class="msa-cpath__settings-grid">
                <label class="msa-cpath__field msa-cpath__field--duration">
                  <span>Path duration</span>
                  <div class="msa-cpath__duration-composite">
                    <input type="number" min="1" step="1" data-input="duration" aria-label="Path duration in seconds">
                    <span class="msa-cpath__duration-unit">sec</span>
                    <span class="msa-cpath__duration-eq" aria-hidden="true">≈</span>
                    <span class="msa-cpath__duration-readout" data-bind="durationHuman">—</span>
                  </div>
                </label>
                <label class="msa-cpath__field">
                  <span>Easing</span>
                  <select data-input="easing">
                    <option value="trapezoidal">Trapezoidal (Cinematic)</option>
                    <option value="easeInOutCosine">Ease In-Out Cosine</option>
                  </select>
                </label>
              </div>
            </section>

            <section class="msa-cpath__card">
              <h3 class="msa-cpath__section-title">Presentation</h3>
              <div class="msa-cpath__settings-grid">
                <label class="msa-cpath__field">
                  <span>Fade duration (ms)</span>
                  <input type="number" min="0" step="100" data-input="fadeDurationMs">
                </label>
                <label class="msa-cpath__field">
                  <span>Black hold (ms)</span>
                  <input type="number" min="0" step="100" data-input="fadeHoldMs">
                </label>
              </div>
              <div class="msa-cpath__checks msa-cpath__checks--3col">
                <label class="msa-cpath__check"><input type="checkbox" data-input="hideUi"> Hide UI</label>
                <label class="msa-cpath__check"><input type="checkbox" data-input="hideMapLayers"> Hide Map Layers</label>
                <label class="msa-cpath__check"><input type="checkbox" data-input="letterbox"> Letterbox</label>
                <label class="msa-cpath__check"><input type="checkbox" data-input="fadeFromBlack"> Fade from black</label>
                <label class="msa-cpath__check"><input type="checkbox" data-input="fadeToBlack"> Fade to black</label>
                <label class="msa-cpath__check"><input type="checkbox" data-input="syncToPlayers"> Sync to Players</label>
              </div>
            </section>

            <section class="msa-cpath__card msa-cpath__card--env">
              <div class="msa-cpath__card-head">
                <h3 class="msa-cpath__section-title">Environment Ramp</h3>
                <label class="msa-cpath__toggle">
                  <input type="checkbox" data-input="environmentRampEnabled">
                  <span>Animate during path</span>
                </label>
              </div>
              <p class="msa-cpath__hint">Blend weather and time from <strong>Before</strong> to <strong>After</strong> while the camera moves (not during black fades).</p>

              <div class="msa-cpath__env-panels" data-bind="environmentPanels">
                <div class="msa-cpath__env-panel msa-cpath__env-panel--start">
                  <div class="msa-cpath__env-panel-head">
                    <div class="msa-cpath__env-panel-title">
                      <span class="msa-cpath__env-badge msa-cpath__env-badge--start">Before</span>
                      <span>Start state</span>
                    </div>
                    <button type="button" class="msa-cpath__btn msa-cpath__btn--small msa-cpath__btn--capture" data-action="capture-env-start">Capture current</button>
                  </div>
                  <div class="msa-cpath__env-sliders" data-bind="environment-start"></div>
                </div>

                <div class="msa-cpath__env-bridge" aria-hidden="true">
                  <span class="msa-cpath__env-bridge-arrow">→</span>
                  <span class="msa-cpath__env-bridge-label">during path</span>
                </div>

                <div class="msa-cpath__env-panel msa-cpath__env-panel--end">
                  <div class="msa-cpath__env-panel-head">
                    <div class="msa-cpath__env-panel-title">
                      <span class="msa-cpath__env-badge msa-cpath__env-badge--end">After</span>
                      <span>End state</span>
                    </div>
                    <button type="button" class="msa-cpath__btn msa-cpath__btn--small msa-cpath__btn--capture" data-action="capture-env-end">Capture current</button>
                  </div>
                  <div class="msa-cpath__env-sliders" data-bind="environment-end"></div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>

      <div class="msa-cpath__footer">
        <button type="button" class="msa-cpath__btn msa-cpath__btn--primary" data-action="play">Start Playback</button>
        <button type="button" class="msa-cpath__btn msa-cpath__btn--warn" data-action="stop" disabled>Stop</button>
        <button type="button" class="msa-cpath__btn" data-action="hide-ui">Hide UI (30s)</button>
      </div>
    `;

    parentElement.appendChild(container);
    this.container = container;
    this._renderPoints();
    this._renderEnvironmentControls();
    this._bindEvents();
    this.refresh();
  }

  show() {
    if (!this.container) this.initialize();
    if (!this.container) return;
    this.container.style.display = 'flex';
    this.visible = true;
    this.refresh();
  }

  hide() {
    if (!this.container) return;
    this.container.style.display = 'none';
    this.visible = false;
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  destroy() {
    if (this.container) {
      try { this.container.remove(); } catch (_) {}
    }
    this.container = null;
    this.visible = false;
  }

  refresh() {
    if (!this.container) return;
    const data = this.service.loadData();
    const settings = data.settings || {};

    const durationInput = this.container.querySelector('[data-input="duration"]');
    if (durationInput) durationInput.value = String(settings.duration ?? 15);
    this._updateDurationReadout(settings.duration ?? 15);

    const easingInput = this.container.querySelector('[data-input="easing"]');
    if (easingInput) easingInput.value = settings.easing === 'easeInOutCosine' ? 'easeInOutCosine' : 'trapezoidal';

    const fadeDurationInput = this.container.querySelector('[data-input="fadeDurationMs"]');
    if (fadeDurationInput) fadeDurationInput.value = String(settings.fadeDurationMs ?? 8000);

    const fadeHoldInput = this.container.querySelector('[data-input="fadeHoldMs"]');
    if (fadeHoldInput) fadeHoldInput.value = String(settings.fadeHoldMs ?? 4000);

    this._setCheckbox('hideUi', settings.hideUi !== false);
    this._setCheckbox('hideMapLayers', settings.hideMapLayers !== false);
    this._setCheckbox('letterbox', settings.letterbox === true);
    this._setCheckbox('fadeFromBlack', settings.fadeFromBlack !== false);
    this._setCheckbox('fadeToBlack', settings.fadeToBlack !== false);
    this._setCheckbox('syncToPlayers', settings.syncToPlayers === true);
    this._setCheckbox('environmentRampEnabled', settings.environmentRamp?.enabled === true);

    this._syncEnvironmentInputs(settings.environmentRamp);
    this._syncSigLocSettings(settings);
    this._renderSignificantLocations(data.significantLocations || []);
    this._renderTimeline();
    this._syncPointInputs(data.points || {});
    this._updateEnvironmentPanelState();
    this._updatePlaybackState();
  }

  /** @private */
  _setCheckbox(name, checked) {
    const el = this.container?.querySelector(`[data-input="${name}"]`);
    if (el) el.checked = checked;
  }

  /** @private */
  _renderPoints() {
    const host = this.container?.querySelector('[data-bind="points"]');
    if (!host) return;

    host.innerHTML = CAMERA_PATH_POINT_KEYS.map((key) => `
      <tr class="msa-cpath__point-row" data-point="${key}">
        <th scope="row" class="msa-cpath__point-key">${key}</th>
        <td><input type="number" class="msa-cpath__point-input" data-point-field="x" data-point="${key}" aria-label="Point ${key} X"></td>
        <td><input type="number" class="msa-cpath__point-input" data-point-field="y" data-point="${key}" aria-label="Point ${key} Y"></td>
        <td><input type="number" step="0.05" class="msa-cpath__point-input" data-point-field="scale" data-point="${key}" aria-label="Point ${key} Zoom"></td>
        <td class="msa-cpath__point-actions">
          <button type="button" class="msa-cpath__btn msa-cpath__btn--action" data-action="goto" data-point="${key}" title="Move the camera to this point for a live preview">Pan here</button>
          <button type="button" class="msa-cpath__btn msa-cpath__btn--action" data-action="record" data-point="${key}" title="Save the current camera view into this point">Save view</button>
        </td>
      </tr>
    `).join('');
  }

  /**
   * @param {'start'|'end'} side
   * @param {HTMLElement} host
   * @private
   */
  _renderEnvironmentPanel(side, host) {
    if (!host) return;

    for (const spec of ENVIRONMENT_OVERRIDE_SPECS) {
      const row = document.createElement('div');
      row.className = 'msa-cpath__env-row';
      row.dataset.envField = spec.id;

      const label = document.createElement('label');
      label.className = 'msa-cpath__env-label';
      label.textContent = spec.label;
      label.title = spec.label;

      const controls = document.createElement('div');
      controls.className = 'msa-cpath__env-controls';

      const range = document.createElement('input');
      range.type = 'range';
      range.min = String(spec.min);
      range.max = String(spec.max);
      range.step = String(spec.step);
      range.dataset.envSide = side;
      range.dataset.envField = spec.id;
      range.setAttribute('aria-label', `${side} ${spec.label}`);

      const num = document.createElement('input');
      num.type = 'number';
      num.className = 'msa-cpath__env-num';
      num.min = String(spec.min);
      num.max = String(spec.max);
      num.step = String(spec.step);
      num.dataset.envSide = side;
      num.dataset.envField = spec.id;
      num.setAttribute('aria-label', `${side} ${spec.label} value`);

      controls.append(range, num);

      if (spec.id === 'timeOfDay') {
        const readout = document.createElement('span');
        readout.className = 'msa-cpath__env-time-readout';
        readout.dataset.envTimeReadout = side;
        readout.textContent = formatTimeOfDayLabel(12);
        controls.append(readout);
      }

      row.append(label, controls);
      host.appendChild(row);
    }
  }

  /** @private */
  _renderEnvironmentControls() {
    const startHost = this.container?.querySelector('[data-bind="environment-start"]');
    const endHost = this.container?.querySelector('[data-bind="environment-end"]');
    this._renderEnvironmentPanel('start', startHost);
    this._renderEnvironmentPanel('end', endHost);
  }

  /**
   * @param {string} fieldId
   * @param {import('./environment-control-api.js').EnvironmentSnapshot} snap
   * @returns {number}
   * @private
   */
  _readEnvFieldFromSnapshot(fieldId, snap) {
    const s = normalizeEnvironmentSnapshot(snap);
    if (fieldId === 'timeOfDay') return s.timeOfDay;
    if (fieldId === 'manualFogDensity') return s.manualFogDensity;
    if (fieldId === 'lightning') return s.lightning;
    return s.weather?.[/** @type {keyof typeof s.weather} */ (fieldId)] ?? 0;
  }

  /**
   * @param {number} seconds
   * @private
   */
  _updateDurationReadout(seconds) {
    const el = this.container?.querySelector('[data-bind="durationHuman"]');
    if (el) el.textContent = formatDurationHuman(seconds);
  }

  /**
   * @param {import('../foundry/camera-path-service.js').CameraPathSettings} settings
   * @private
   */
  _syncSigLocSettings(settings) {
    const hold = this.container?.querySelector('[data-input="defaultSigHoldSec"]');
    const trans = this.container?.querySelector('[data-input="sigTransitionSec"]');
    if (hold) hold.value = String(settings.defaultSigHoldSec ?? 8);
    if (trans) trans.value = String(settings.sigTransitionSec ?? 2);
  }

  /**
   * @param {import('../foundry/camera-path-types.js').SignificantLocation[]} locations
   * @private
   */
  _renderSignificantLocations(locations) {
    const host = this.container?.querySelector('[data-bind="sigLocs"]');
    if (!host) return;

    if (!locations.length) {
      host.innerHTML = '<p class="msa-cpath__sig-empty">No significant locations recorded yet.</p>';
      return;
    }

    const partialData = this._collectPartialPathData();
    const placement = this.service.getPlacementOptions(partialData);

    host.innerHTML = locations.map((loc) => {
      const hold = Number.isFinite(Number(loc.holdSec)) ? loc.holdSec : '';
      const mode = loc.placementMode || 'auto';
      const target = loc.placementTarget || '';
      const selectedClass = this._selectedSigLocId === loc.id ? ' msa-cpath__sig-item--selected' : '';
      const targetOptions = mode === 'split'
        ? placement.split
        : mode === 'interstitial'
          ? placement.interstitial
          : [];
      const effectiveTarget = target || targetOptions[0]?.value || '';

      const targetSelect = mode === 'auto'
        ? ''
        : targetOptions.length
          ? `
          <label class="msa-cpath__sig-placement-target">
            <span>Target</span>
            <select data-sig-field="placementTarget" data-sig-id="${escapeHtml(loc.id)}" aria-label="Placement target for ${escapeHtml(loc.name)}">
              ${targetOptions.map((opt) => (
                `<option value="${escapeHtml(opt.value)}"${opt.value === effectiveTarget ? ' selected' : ''}>${escapeHtml(opt.label)}</option>`
              )).join('')}
            </select>
          </label>`
          : '<span class="msa-cpath__hint msa-cpath__hint--tight">No valid target for this path.</span>';

      return `
        <div class="msa-cpath__sig-item${selectedClass}" data-sig-id="${escapeHtml(loc.id)}">
          <button type="button" class="msa-cpath__sig-drag" data-sig-drag="${escapeHtml(loc.id)}" aria-label="Drag to reorder ${escapeHtml(loc.name)}" title="Drag to reorder">⋮⋮</button>
          <div class="msa-cpath__sig-item-body">
            <div class="msa-cpath__sig-item-head">
              <span class="msa-cpath__sig-name">${escapeHtml(loc.name)}</span>
              <label class="msa-cpath__sig-hold">
                <span>Hold</span>
                <input type="number" min="0.5" step="0.5" data-sig-field="holdSec" data-sig-id="${escapeHtml(loc.id)}"
                  value="${hold}" placeholder="default" aria-label="Hold duration for ${escapeHtml(loc.name)}">
                <span>sec</span>
              </label>
            </div>
            <div class="msa-cpath__sig-placement">
              <label class="msa-cpath__sig-placement-mode">
                <span>Placement</span>
                <select data-sig-field="placementMode" data-sig-id="${escapeHtml(loc.id)}" aria-label="Placement mode for ${escapeHtml(loc.name)}">
                  <option value="auto"${mode === 'auto' ? ' selected' : ''}>Auto</option>
                  <option value="interstitial"${mode === 'interstitial' ? ' selected' : ''}>Between sweeps</option>
                  <option value="split"${mode === 'split' ? ' selected' : ''}>Split sweep</option>
                </select>
              </label>
              ${targetSelect}
            </div>
            <div class="msa-cpath__sig-item-actions">
              <button type="button" class="msa-cpath__btn msa-cpath__btn--action" data-action="goto-sig" data-sig-id="${escapeHtml(loc.id)}">Pan here</button>
              <button type="button" class="msa-cpath__btn msa-cpath__btn--action msa-cpath__btn--warn-text" data-action="delete-sig" data-sig-id="${escapeHtml(loc.id)}">Delete</button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  /** @private */
  _renderTimeline() {
    const track = this.container?.querySelector('[data-bind="timeline"]');
    const ruler = this.container?.querySelector('[data-bind="timelineRuler"]');
    const totalEl = this.container?.querySelector('[data-bind="timelineTotal"]');
    const warnEl = this.container?.querySelector('[data-bind="timelineWarn"]');
    if (!track) return;

    const preview = this.service.getTimelinePreview(this._collectDataFromUi());
    const totalMs = Math.max(1, preview.totalMs || 1);

    if (totalEl) {
      totalEl.textContent = `Total ≈ ${formatDurationHuman(Math.round(totalMs / 1000))}`;
    }

    if (warnEl) {
      if (preview.unplacedSigLocIds?.length) {
        warnEl.hidden = false;
        warnEl.textContent = `${preview.unplacedSigLocIds.length} location(s) could not be scheduled (add longer sweeps, fewer locations, or adjust placement).`;
      } else {
        warnEl.hidden = true;
        warnEl.textContent = '';
      }
    }

    const tickPercents = [0, 25, 50, 75, 100];
    if (ruler) {
      ruler.innerHTML = tickPercents.map((pct) => {
        const sec = Math.round((pct / 100) * totalMs / 1000);
        return `<span class="msa-cpath__tl-ruler-label" style="left: ${pct}%;">${escapeHtml(formatDurationHuman(sec))}</span>`;
      }).join('');
    }

    track.innerHTML = preview.summary.map((item) => {
      const pct = Math.max(2, (item.durationMs / totalMs) * 100);
      const title = `${item.label} (${formatDurationHuman(Math.max(1, Math.round(item.durationMs / 1000)))})`;
      const sigAttr = item.sigLocId ? ` data-sig-loc-id="${escapeHtml(item.sigLocId)}"` : '';
      const selectedClass = item.sigLocId && item.sigLocId === this._selectedSigLocId
        ? ' msa-cpath__tl-block--selected'
        : '';
      return `
        <div class="msa-cpath__tl-block ${item.colorClass}${selectedClass}" data-clip-id="${escapeHtml(item.id)}"${sigAttr}
          style="flex: ${pct} 1 0;" title="${escapeHtml(title)}">
          <span class="msa-cpath__tl-label">${escapeHtml(item.label)}</span>
        </div>
      `;
    }).join('');
  }

  /**
   * Path data for placement preview (points + settings, preserves sig loc order from DOM when possible).
   * @returns {import('../foundry/camera-path-service.js').CameraPathData}
   * @private
   */
  _collectPartialPathData() {
    const existing = this.service.loadData();
    return {
      points: this._collectPointsFromUi(existing.points || {}),
      significantLocations: this._collectSignificantLocationsFromUi(existing.significantLocations || []),
      settings: this._collectSettingsFromUi(),
    };
  }

  /**
   * @param {import('./environment-control-api.js').EnvironmentRampConfig|null|undefined} ramp
   * @private
   */
  _syncEnvironmentInputs(ramp) {
    if (!this.container) return;
    const normalized = {
      enabled: ramp?.enabled === true,
      start: normalizeEnvironmentSnapshot(ramp?.start),
      end: normalizeEnvironmentSnapshot(ramp?.end),
    };

    for (const spec of ENVIRONMENT_OVERRIDE_SPECS) {
      for (const side of ['start', 'end']) {
        const snap = side === 'start' ? normalized.start : normalized.end;
        const value = this._readEnvFieldFromSnapshot(spec.id, snap);
        const range = this.container.querySelector(`[data-env-side="${side}"][data-env-field="${spec.id}"][type="range"]`);
        const num = this.container.querySelector(`[data-env-side="${side}"][data-env-field="${spec.id}"][type="number"]`);
        if (range) range.value = String(value);
        if (num) num.value = String(value);
        if (spec.id === 'timeOfDay') {
          this._updateTimeReadout(side, value);
        }
      }
    }
  }

  /**
   * @param {'start'|'end'} side
   * @param {number} hour
   * @private
   */
  _updateTimeReadout(side, hour) {
    const readout = this.container?.querySelector(`[data-env-time-readout="${side}"]`);
    if (readout) readout.textContent = formatTimeOfDayLabel(hour);
  }

  /** @private */
  _updateEnvironmentPanelState() {
    const enabled = !!this.container?.querySelector('[data-input="environmentRampEnabled"]')?.checked;
    const playing = this.service.isPlaying;
    const panels = this.container?.querySelector('[data-bind="environmentPanels"]');
    if (panels) {
      panels.classList.toggle('msa-cpath__env-panels--disabled', !enabled);
    }
    this.container?.querySelectorAll('[data-env-side]').forEach((el) => {
      if (el instanceof HTMLInputElement) {
        el.disabled = !enabled || playing;
      }
    });
    this.container?.querySelectorAll('[data-action="capture-env-start"], [data-action="capture-env-end"]').forEach((el) => {
      if (el instanceof HTMLButtonElement) {
        el.disabled = !enabled || playing;
      }
    });
  }

  /**
   * @param {'start'|'end'} side
   * @returns {import('./environment-control-api.js').EnvironmentSnapshot}
   * @private
   */
  _collectEnvironmentSideFromUi(side) {
    const existing = this.service.loadData().settings?.environmentRamp;
    const base = normalizeEnvironmentSnapshot(side === 'start' ? existing?.start : existing?.end);

    for (const spec of ENVIRONMENT_OVERRIDE_SPECS) {
      const num = this.container?.querySelector(
        `[data-env-side="${side}"][data-env-field="${spec.id}"][type="number"]`,
      );
      const raw = num?.value;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;

      if (spec.id === 'timeOfDay') base.timeOfDay = value;
      else if (spec.id === 'manualFogDensity') base.manualFogDensity = value;
      else if (spec.id === 'lightning') base.lightning = value;
      else if (base.weather) base.weather[/** @type {keyof typeof base.weather} */ (spec.id)] = value;
    }

    return normalizeEnvironmentSnapshot(base);
  }

  /**
   * @returns {import('./environment-control-api.js').EnvironmentRampConfig}
   * @private
   */
  _collectEnvironmentRampFromUi() {
    return {
      enabled: !!this.container?.querySelector('[data-input="environmentRampEnabled"]')?.checked,
      start: this._collectEnvironmentSideFromUi('start'),
      end: this._collectEnvironmentSideFromUi('end'),
    };
  }

  /**
   * @param {'start'|'end'} side
   * @private
   */
  _captureEnvironmentSideFromCurrent(side) {
    const snap = environmentControlApi.captureSnapshot();
    this._applyEnvironmentSideToUi(side, snap);
  }

  /**
   * @param {'start'|'end'} side
   * @param {import('./environment-control-api.js').EnvironmentSnapshot} snap
   * @private
   */
  _applyEnvironmentSideToUi(side, snap) {
    for (const spec of ENVIRONMENT_OVERRIDE_SPECS) {
      const value = this._readEnvFieldFromSnapshot(spec.id, snap);
      const range = this.container?.querySelector(`[data-env-side="${side}"][data-env-field="${spec.id}"][type="range"]`);
      const num = this.container?.querySelector(`[data-env-side="${side}"][data-env-field="${spec.id}"][type="number"]`);
      if (range) range.value = String(value);
      if (num) num.value = String(value);
      if (spec.id === 'timeOfDay') {
        this._updateTimeReadout(side, value);
      }
    }
  }

  /**
   * @param {Record<string, {x?: number|null, y?: number|null, scale?: number|null}>} points
   * @private
   */
  _syncPointInputs(points) {
    if (!this.container) return;
    for (const key of CAMERA_PATH_POINT_KEYS) {
      const p = points[key] || {};
      for (const field of ['x', 'y', 'scale']) {
        const input = this.container.querySelector(`[data-point-field="${field}"][data-point="${key}"]`);
        if (!input) continue;
        const val = p[field];
        input.value = val === null || val === undefined || val === '' ? '' : String(val);
      }
    }
  }

  /** @private */
  _collectSettingsFromUi() {
    const root = this.container;
    if (!root) return this.service.loadData().settings;

    return {
      duration: Number(root.querySelector('[data-input="duration"]')?.value) || 15,
      easing: root.querySelector('[data-input="easing"]')?.value === 'easeInOutCosine'
        ? 'easeInOutCosine'
        : 'trapezoidal',
      hideUi: !!root.querySelector('[data-input="hideUi"]')?.checked,
      hideMapLayers: !!root.querySelector('[data-input="hideMapLayers"]')?.checked,
      letterbox: !!root.querySelector('[data-input="letterbox"]')?.checked,
      fadeFromBlack: !!root.querySelector('[data-input="fadeFromBlack"]')?.checked,
      fadeToBlack: !!root.querySelector('[data-input="fadeToBlack"]')?.checked,
      fadeDurationMs: Math.max(0, Number(root.querySelector('[data-input="fadeDurationMs"]')?.value) || 8000),
      fadeHoldMs: Math.max(0, Number(root.querySelector('[data-input="fadeHoldMs"]')?.value) || 4000),
      syncToPlayers: !!root.querySelector('[data-input="syncToPlayers"]')?.checked,
      defaultSigHoldSec: Math.max(0.5, Number(root.querySelector('[data-input="defaultSigHoldSec"]')?.value) || 8),
      sigTransitionSec: Math.max(0, Number(root.querySelector('[data-input="sigTransitionSec"]')?.value) || 2),
      environmentRamp: this._collectEnvironmentRampFromUi(),
    };
  }

  /**
   * @param {Record<string, {x?: number|null, y?: number|null, scale?: number|null}>} fallbackPoints
   * @returns {Record<string, {x: number|null, y: number|null, scale: number|null}>}
   * @private
   */
  _collectPointsFromUi(fallbackPoints = {}) {
    /** @type {Record<string, {x: number|null, y: number|null, scale: number|null}>} */
    const points = { ...(fallbackPoints || {}) };

    for (const key of CAMERA_PATH_POINT_KEYS) {
      const xRaw = this.container?.querySelector(`[data-point-field="x"][data-point="${key}"]`)?.value;
      const yRaw = this.container?.querySelector(`[data-point-field="y"][data-point="${key}"]`)?.value;
      const scaleRaw = this.container?.querySelector(`[data-point-field="scale"][data-point="${key}"]`)?.value;

      const x = xRaw === '' ? null : Number(xRaw);
      const y = yRaw === '' ? null : Number(yRaw);
      const scale = scaleRaw === '' ? null : Number(scaleRaw);

      points[key] = {
        x: Number.isFinite(x) ? x : null,
        y: Number.isFinite(y) ? y : null,
        scale: Number.isFinite(scale) ? scale : null,
      };
    }

    return points;
  }

  /**
   * @param {import('../foundry/camera-path-types.js').SignificantLocation[]} existing
   * @returns {import('../foundry/camera-path-types.js').SignificantLocation[]}
   * @private
   */
  _collectSignificantLocationsFromUi(existing = []) {
    const host = this.container?.querySelector('[data-bind="sigLocs"]');
    const byId = new Map((existing || []).map((loc) => [loc.id, { ...loc }]));
    /** @type {import('../foundry/camera-path-types.js').SignificantLocation[]} */
    const ordered = [];

    const items = host?.querySelectorAll('[data-sig-id]') ?? [];
    for (const el of items) {
      const id = el instanceof HTMLElement ? el.dataset.sigId : null;
      if (!id || !byId.has(id)) continue;
      const loc = byId.get(id);

      const holdInput = this.container?.querySelector(`[data-sig-field="holdSec"][data-sig-id="${id}"]`);
      const rawHold = holdInput instanceof HTMLInputElement ? holdInput.value.trim() : '';
      const hold = rawHold === '' ? undefined : Number(rawHold);

      const modeInput = this.container?.querySelector(`[data-sig-field="placementMode"][data-sig-id="${id}"]`);
      const modeRaw = modeInput instanceof HTMLSelectElement ? modeInput.value : 'auto';
      const placementMode = modeRaw === 'interstitial' || modeRaw === 'split' ? modeRaw : 'auto';

      const targetInput = this.container?.querySelector(`[data-sig-field="placementTarget"][data-sig-id="${id}"]`);
      const placementTarget = targetInput instanceof HTMLSelectElement && placementMode !== 'auto'
        ? targetInput.value
        : undefined;

      /** @type {import('../foundry/camera-path-types.js').SignificantLocation} */
      const next = {
        ...loc,
        holdSec: Number.isFinite(hold) && hold > 0 ? hold : undefined,
        placementMode,
      };
      if (placementTarget) next.placementTarget = placementTarget;
      else delete next.placementTarget;

      ordered.push(next);
      byId.delete(id);
    }

    for (const loc of byId.values()) ordered.push(loc);
    return ordered;
  }

  /**
   * @returns {import('../foundry/camera-path-service.js').CameraPathData}
   * @private
   */
  _collectDataFromUi() {
    const existing = this.service.loadData();

    return {
      points: this._collectPointsFromUi(existing.points || {}),
      significantLocations: this._collectSignificantLocationsFromUi(existing.significantLocations || []),
      settings: this._collectSettingsFromUi(),
    };
  }

  /** @private */
  async _persistFromUi() {
    const data = this._collectDataFromUi();
    await this.service.saveData(data);
    return data;
  }

  /** @private */
  _updatePlaybackState() {
    const playing = this.service.isPlaying;
    const statusEl = this.container?.querySelector('[data-bind="status"]');
    if (statusEl) statusEl.textContent = playing ? 'Playing…' : 'Ready';

    const playBtn = this.container?.querySelector('[data-action="play"]');
    const stopBtn = this.container?.querySelector('[data-action="stop"]');
    if (playBtn) playBtn.disabled = playing;
    if (stopBtn) stopBtn.disabled = !playing;

    this.container?.querySelectorAll('input, select, button[data-action="generate"], button[data-action="goto"], button[data-action="record"]')
      .forEach((el) => {
        if (el.matches('[data-action="stop"], [data-action="close"]')) return;
        el.disabled = playing;
      });

    this._updateEnvironmentPanelState();
  }

  /** @private */
  _bindEvents() {
    const root = this.container;
    if (!root) return;

    const stop = (e) => { try { e.stopPropagation(); } catch (_) {} };
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick', 'keydown']) {
      root.addEventListener(type, stop);
    }
    root.addEventListener('wheel', stop, { passive: true });

    root.addEventListener('click', async (event) => {
      const actionEl = event.target?.closest?.('[data-action]');
      if (!actionEl || actionEl.disabled) return;

      switch (actionEl.dataset.action) {
        case 'close':
          this.hide();
          break;
        case 'generate':
          await this._onGenerate();
          break;
        case 'play':
          await this._onPlay();
          break;
        case 'stop':
          this.service.stopPlayback();
          break;
        case 'hide-ui':
          await this._onHideUi();
          break;
        case 'goto':
          this._onGoto(actionEl.dataset.point);
          break;
        case 'record':
          await this._onRecord(actionEl.dataset.point);
          break;
        case 'capture-env-start':
          this._captureEnvironmentSideFromCurrent('start');
          await this._persistFromUi();
          break;
        case 'capture-env-end':
          this._captureEnvironmentSideFromCurrent('end');
          await this._persistFromUi();
          break;
        case 'record-sig-loc':
          await this._onRecordSigLoc();
          break;
        case 'goto-sig':
          this._onGotoSigLoc(actionEl.dataset.sigId);
          break;
        case 'delete-sig':
          await this._onDeleteSigLoc(actionEl.dataset.sigId);
          break;
        default:
          break;
      }
    });

    root.addEventListener('click', (event) => {
      const clipEl = event.target?.closest?.('[data-sig-loc-id]');
      if (clipEl instanceof HTMLElement && clipEl.dataset.sigLocId) {
        this._selectedSigLocId = clipEl.dataset.sigLocId;
        this._renderSignificantLocations(this._collectSignificantLocationsFromUi(this.service.loadData().significantLocations || []));
        this._renderTimeline();
      }
    });

    root.addEventListener('input', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;

      if (target.dataset.envSide && target.dataset.envField) {
        const side = target.dataset.envSide;
        const field = target.dataset.envField;
        const pairType = target.type === 'range' ? 'number' : 'range';
        const pair = root.querySelector(
          `[data-env-side="${side}"][data-env-field="${field}"][type="${pairType}"]`,
        );
        if (pair instanceof HTMLInputElement) {
          pair.value = target.value;
        }
        if (field === 'timeOfDay') {
          this._updateTimeReadout(/** @type {'start'|'end'} */ (side), Number(target.value));
        }
        try {
          await this._persistFromUi();
        } catch (err) {
          log.warn('Failed to save environment ramp', err);
        }
        return;
      }

      if (target.dataset.pointField && target.dataset.point) {
        await this._onPointInput(target.dataset.point);
        return;
      }

      if (target.dataset.input === 'duration') {
        this._updateDurationReadout(Number(target.value));
      }

      if (target.dataset.input) {
        try {
          await this._persistFromUi();
          this._renderTimeline();
        } catch (err) {
          log.warn('Failed to save settings', err);
        }
      }

      if (target.dataset.sigField && target.dataset.sigId) {
        try {
          if (target.dataset.sigField === 'placementMode') {
            const data = this._collectDataFromUi();
            this._renderSignificantLocations(data.significantLocations || []);
          }
          await this._persistFromUi();
          this._renderTimeline();
        } catch (err) {
          log.warn('Failed to save significant location', err);
        }
      }
    });

    root.addEventListener('change', async (event) => {
      const target = event.target;
      if (target instanceof HTMLSelectElement && target.dataset.sigField && target.dataset.sigId) {
        try {
          if (target.dataset.sigField === 'placementMode') {
            const data = this._collectDataFromUi();
            this._renderSignificantLocations(data.significantLocations || []);
          }
          await this._persistFromUi();
          this._renderTimeline();
        } catch (err) {
          log.warn('Failed to save significant location placement', err);
        }
        return;
      }
      if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) return;
      if (!target.dataset.input) return;
      if (target.dataset.input === 'environmentRampEnabled') {
        this._updateEnvironmentPanelState();
      }
      try {
        await this._persistFromUi();
        this._renderTimeline();
      } catch (err) {
        log.warn('Failed to save settings', err);
      }
    });

    this._installDrag();
    this._installSigLocReorder();
  }

  /** @private */
  _installSigLocReorder() {
    const host = this.container?.querySelector('[data-bind="sigLocs"]');
    if (!host) return;

    const onPointerMove = async (ev) => {
      const drag = this._sigLocDrag;
      if (!drag) return;

      const items = [...host.querySelectorAll('[data-sig-id]')];
      const y = ev.clientY;
      let insertBefore = null;
      for (const item of items) {
        if (item === drag.el) continue;
        const rect = item.getBoundingClientRect();
        if (y < rect.top + rect.height / 2) {
          insertBefore = item;
          break;
        }
      }

      if (insertBefore) host.insertBefore(drag.el, insertBefore);
      else host.appendChild(drag.el);
    };

    const onPointerUp = async () => {
      const drag = this._sigLocDrag;
      if (!drag) return;
      this._sigLocDrag = null;
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);

      const orderedIds = [...host.querySelectorAll('[data-sig-id]')]
        .map((el) => (el instanceof HTMLElement ? el.dataset.sigId : null))
        .filter(Boolean);

      try {
        await this.service.reorderSignificantLocations(/** @type {string[]} */ (orderedIds));
        await this._persistFromUi();
        this.refresh();
      } catch (err) {
        log.warn('Sig loc reorder failed', err);
      }
    };

    host.addEventListener('pointerdown', (ev) => {
      const handle = ev.target?.closest?.('[data-sig-drag]');
      if (!(handle instanceof HTMLElement)) return;
      const item = handle.closest('[data-sig-id]');
      if (!(item instanceof HTMLElement) || this.service.isPlaying) return;

      this._sigLocDrag = { id: item.dataset.sigId || '', el: item };
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      ev.preventDefault();
    });
  }

  /** @private */
  async _onRecordSigLoc() {
    const name = window.prompt?.('Name this significant location:', 'Location');
    if (name == null) return;
    const trimmed = String(name).trim();
    if (!trimmed) {
      ui.notifications?.warn?.('Location name is required.');
      return;
    }

    try {
      await this._persistFromUi();
      const loc = await this.service.recordSignificantLocation(trimmed);
      if (!loc) {
        ui.notifications?.error?.('Could not record location.');
        return;
      }
      ui.notifications?.info?.(`Recorded "${loc.name}".`);
      this.refresh();
    } catch (err) {
      log.warn('Record significant location failed', err);
      ui.notifications?.error?.('Failed to record significant location.');
    }
  }

  /**
   * @param {string|undefined} id
   * @private
   */
  _onGotoSigLoc(id) {
    if (!id) return;
    const ok = this.service.goToSignificantLocation(id);
    if (!ok) ui.notifications?.warn?.('Location not found.');
  }

  /**
   * @param {string|undefined} id
   * @private
   */
  async _onDeleteSigLoc(id) {
    if (!id) return;
    try {
      const ok = await this.service.removeSignificantLocation(id);
      if (!ok) return;
      this.refresh();
    } catch (err) {
      log.warn('Delete significant location failed', err);
    }
  }

  /** @private */
  async _onGenerate() {
    const preset = this.container?.querySelector('[data-input="preset"]')?.value;
    if (!preset) return;

    try {
      await this._persistFromUi();
      const data = await this.service.generatePreset(/** @type {any} */ (preset));
      if (!data) {
        ui.notifications?.error?.('Could not generate path — scene dimensions seem invalid.');
        return;
      }
      ui.notifications?.info?.('Camera path generated.');
      this.refresh();
    } catch (err) {
      log.warn('Generate failed', err);
      ui.notifications?.error?.('Failed to generate camera path.');
    }
  }

  /** @private */
  async _onPlay() {
    try {
      const data = await this._persistFromUi();
      this.hide();
      this._updatePlaybackState();
      await this.service.startPlayback(data);
    } catch (err) {
      log.warn('Playback failed', err);
    } finally {
      this._updatePlaybackState();
      if (this.visible === false) this.show();
    }
  }

  /** @private */
  async _onHideUi() {
    this.hide();
    await this.service.hideUiTemporary(30000);
    this.show();
  }

  /**
   * @param {string} pointKey
   * @private
   */
  _onGoto(pointKey) {
    if (!pointKey) return;
    const ok = this.service.goToPoint(pointKey);
    if (!ok) ui.notifications?.warn?.(`Point ${pointKey} is empty.`);
  }

  /**
   * @param {string} pointKey
   * @private
   */
  async _onRecord(pointKey) {
    if (!pointKey) return;
    try {
      await this.service.recordPoint(pointKey);
      this.refresh();
      ui.notifications?.info?.(`Point ${pointKey} recorded.`);
    } catch (err) {
      log.warn('Record failed', err);
      ui.notifications?.error?.(`Failed to record point ${pointKey}.`);
    }
  }

  /**
   * @param {string} pointKey
   * @private
   */
  async _onPointInput(pointKey) {
    const xRaw = this.container?.querySelector(`[data-point-field="x"][data-point="${pointKey}"]`)?.value;
    const yRaw = this.container?.querySelector(`[data-point-field="y"][data-point="${pointKey}"]`)?.value;
    const scaleRaw = this.container?.querySelector(`[data-point-field="scale"][data-point="${pointKey}"]`)?.value;

    const x = Number(xRaw);
    const y = Number(yRaw);
    const scale = Number(scaleRaw);

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale)) return;

    try {
      await this.service.updatePoint(pointKey, { x, y, scale });
    } catch (err) {
      log.warn('Point preview failed', err);
    }
  }

  /** @private */
  _installDrag() {
    const root = this.container;
    const handle = root?.querySelector('[data-drag-handle]');
    if (!root || !handle) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let baseLeft = 0;
    let baseTop = 0;

    const onMove = (ev) => {
      if (!dragging) return;
      root.style.left = `${baseLeft + ev.clientX - startX}px`;
      root.style.top = `${baseTop + ev.clientY - startY}px`;
      root.style.right = 'auto';
      root.style.bottom = 'auto';
    };

    const onUp = () => {
      dragging = false;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };

    handle.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      dragging = true;
      startX = ev.clientX;
      startY = ev.clientY;
      const rect = root.getBoundingClientRect();
      baseLeft = rect.left;
      baseTop = rect.top;
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      ev.preventDefault();
    });
  }
}
