/**
 * @fileoverview Performance & Graphics Dialog
 *
 * Plain-language per-client graphics and performance controls for players and GMs.
 * Custom DOM overlay (no Tweakpane) — modeled on PerformanceRecorderDialog.
 *
 * @module ui/graphics-settings-dialog
 */

import { createLogger } from '../core/log.js';

const log = createLogger('GraphicsSettingsDialog');

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

export class GraphicsSettingsDialog {
  /**
   * @param {import('./graphics-settings-manager.js').GraphicsSettingsManager} manager
   */
  constructor(manager) {
    this.manager = manager;

    /** @type {HTMLElement|null} */
    this.container = null;

    /** @type {boolean} */
    this.visible = false;

    /** @type {boolean} */
    this._advancedExpanded = false;

    /** @type {Set<string>} */
    this._expandedGroups = new Set(['weather', 'lighting']);

    this._boundStopHandlers = null;
  }

  /**
   * @param {HTMLElement} [parentElement]
   */
  async initialize(parentElement = document.body) {
    if (this.container) return;

    const container = document.createElement('div');
    container.id = 'map-shine-graphics-settings';
    container.className = 'map-shine-graphics-settings map-shine-overlay-ui';
    container.style.display = 'none';

    container.innerHTML = `
      <div class="msa-gfx__header" data-drag-handle>
        <div class="msa-gfx__header-text">
          <div class="msa-gfx__title">Performance &amp; Graphics</div>
          <div class="msa-gfx__subtitle">These settings apply only to your browser and can help if the map feels slow or choppy.</div>
        </div>
        <button type="button" class="msa-gfx__close" data-action="close" aria-label="Close">×</button>
      </div>

      <div class="msa-gfx__body">
        <section class="msa-gfx__section">
          <div class="msa-gfx__section-title">Performance</div>
          <label class="msa-gfx__field">
            <span class="msa-gfx__label">Smoothness</span>
            <select class="msa-gfx__select" data-input="performanceProfile"></select>
          </label>
          <label class="msa-gfx__field">
            <span class="msa-gfx__label">Render quality</span>
            <select class="msa-gfx__select" data-input="renderResolution"></select>
          </label>
          <div class="msa-gfx__hint msa-gfx__hint--custom-res" data-bind="custom-resolution" hidden></div>
          <label class="msa-gfx__field">
            <span class="msa-gfx__label">Weather &amp; particles</span>
            <select class="msa-gfx__select" data-input="particleSpawn"></select>
          </label>
          <label class="msa-gfx__check">
            <input type="checkbox" data-input="vegetationHalfRes">
            <span>Lower-resolution trees &amp; bushes (performance)</span>
          </label>
          <p class="msa-gfx__hint">When enabled, foliage may look softer but uses less GPU. Off by default for full quality.</p>
        </section>

        <section class="msa-gfx__section">
          <div class="msa-gfx__section-title">
            Effects
            <span class="msa-gfx__count-tag" data-bind="effects-count">0/0 on</span>
          </div>
          <div class="msa-gfx__toolbar">
            <button type="button" class="msa-gfx__btn" data-action="enable-all">Enable all</button>
            <button type="button" class="msa-gfx__btn" data-action="disable-all">Disable all</button>
            <button type="button" class="msa-gfx__btn msa-gfx__btn--danger" data-action="reset-overrides">Reset to scene defaults</button>
          </div>
          <div class="msa-gfx__groups" data-bind="effect-groups"></div>
        </section>

        <section class="msa-gfx__section msa-gfx__section--advanced">
          <button type="button" class="msa-gfx__advanced-toggle" data-action="toggle-advanced">
            <span class="msa-gfx__chevron" data-bind="advanced-chevron">▶</span>
            Advanced
          </button>
          <div class="msa-gfx__advanced-body" data-bind="advanced-body" hidden>
            <label class="msa-gfx__check">
              <input type="checkbox" data-input="tokenDepth">
              <span>Tokens can go behind elevated tiles</span>
            </label>
            <p class="msa-gfx__hint">When enabled, tokens may be hidden by foreground map tiles that rise above them.</p>
          </div>
        </section>

        <p class="msa-gfx__footnote">Saved on this browser only — other players keep their own settings.</p>
      </div>
    `;

    parentElement.appendChild(container);
    this.container = container;

    this._installPointerIsolation();
    this._bindEvents();
    this._installDrag();
    this.hide();

    log.info('Performance & Graphics dialog initialized');
  }

  /** @private */
  _installPointerIsolation() {
    const stop = (e) => {
      try { e.stopPropagation(); } catch (_) {}
    };
    const stopAndPrevent = (e) => {
      try { e.preventDefault(); } catch (_) {}
      stop(e);
    };
    const events = ['pointerdown', 'mousedown', 'click', 'dblclick', 'wheel'];
    for (const type of events) {
      if (type === 'wheel') this.container.addEventListener(type, stop, { passive: true });
      else this.container.addEventListener(type, stop);
    }
    this.container.addEventListener('contextmenu', stopAndPrevent);
    this._boundStopHandlers = { stop, stopAndPrevent };
  }

  /** @private */
  _bindEvents() {
    const root = this.container;
    if (!root) return;

    root.addEventListener('click', (ev) => {
      const btn = ev.target?.closest?.('[data-action]');
      if (!btn || !root.contains(btn)) return;
      const action = btn.dataset.action;
      if (action === 'close') this.hide();
      else if (action === 'enable-all') {
        this.manager.setDisableAll(false);
        this.manager.enableAllEffects();
        this.refresh();
      } else if (action === 'disable-all') {
        this.manager.setDisableAll(true);
        this.manager.disableAllEffects();
        this.refresh();
      } else if (action === 'reset-overrides') {
        this.manager.resetAllOverrides();
        this.refresh();
      } else if (action === 'toggle-advanced') {
        this._advancedExpanded = !this._advancedExpanded;
        this._syncAdvancedSection();
      } else if (action === 'toggle-group') {
        const groupId = btn.dataset.groupId;
        if (!groupId) return;
        if (this._expandedGroups.has(groupId)) this._expandedGroups.delete(groupId);
        else this._expandedGroups.add(groupId);
        this._renderEffectGroups();
      } else if (action === 'reset-resolution') {
        this.manager.resetResolutionToRecommended();
        this.refresh();
      }
    });

    root.addEventListener('change', (ev) => {
      const target = ev.target;
      if (!(target instanceof HTMLSelectElement) && !(target instanceof HTMLInputElement)) return;

      if (target.matches('[data-input="performanceProfile"]')) {
        this.manager.applyPerformanceProfile(target.value);
        this.refresh();
        return;
      }
      if (target.matches('[data-input="renderResolution"]')) {
        this.manager.setRenderResolutionPreset(target.value);
        this.refresh();
        return;
      }
      if (target.matches('[data-input="particleSpawn"]')) {
        this.manager.setParticleSpawnUiTierId(target.value);
        this.refresh();
        return;
      }
      if (target.matches('[data-input="tokenDepth"]')) {
        this.manager.setTokenDepthInteraction(target.checked);
        return;
      }
      if (target.matches('[data-input="vegetationHalfRes"]')) {
        this.manager.setVegetationHalfResEnabled(target.checked);
        return;
      }
      if (target.matches('[data-input="effect-enabled"]')) {
        const effectId = target.dataset.effectId;
        if (!effectId) return;
        this.manager.setEffectEnabled(effectId, target.checked);
        this.manager.saveState();
        this.refreshStatus();
      }
    });
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
      root.style.left = `${baseLeft + (ev.clientX - startX)}px`;
      root.style.top = `${baseTop + (ev.clientY - startY)}px`;
      root.style.transform = 'none';
    };
    const onUp = () => {
      dragging = false;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };

    handle.addEventListener('pointerdown', (ev) => {
      if (ev.target?.closest?.('button')) return;
      dragging = true;
      const rect = root.getBoundingClientRect();
      startX = ev.clientX;
      startY = ev.clientY;
      baseLeft = rect.left;
      baseTop = rect.top;
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      try { ev.preventDefault(); } catch (_) {}
    });
  }

  /** @private */
  _syncAdvancedSection() {
    const body = this.container?.querySelector('[data-bind="advanced-body"]');
    const chevron = this.container?.querySelector('[data-bind="advanced-chevron"]');
    if (body) body.hidden = !this._advancedExpanded;
    if (chevron) chevron.textContent = this._advancedExpanded ? '▼' : '▶';
  }

  /** @private */
  _populatePerformanceControls() {
    const root = this.container;
    if (!root) return;

    const profileSelect = root.querySelector('[data-input="performanceProfile"]');
    if (profileSelect instanceof HTMLSelectElement) {
      const current = this.manager.getPerformanceProfile();
      profileSelect.innerHTML = this.manager.listPerformanceProfileOptions()
        .map((row) => `<option value="${escapeHtml(row.id)}"${row.id === current ? ' selected' : ''}>${escapeHtml(row.label)}</option>`)
        .join('');
      if (current === 'custom') {
        profileSelect.insertAdjacentHTML('beforeend', '<option value="custom" selected>Custom</option>');
      }
    }

    const resSelect = root.querySelector('[data-input="renderResolution"]');
    const customHint = root.querySelector('[data-bind="custom-resolution"]');
    const currentPreset = this.manager.getRenderResolutionPreset();
    const options = this.manager.getResolutionOptionsForViewport();
    const inList = options.some((row) => row.preset === currentPreset);

    if (resSelect instanceof HTMLSelectElement) {
      resSelect.innerHTML = options
        .map((row) => `<option value="${escapeHtml(row.preset)}"${row.preset === currentPreset ? ' selected' : ''}>${escapeHtml(row.label)}</option>`)
        .join('');
      if (!inList && currentPreset) {
        resSelect.insertAdjacentHTML(
          'afterbegin',
          `<option value="${escapeHtml(currentPreset)}" selected>Custom (${escapeHtml(this.manager.getResolutionDisplayLabel(currentPreset))})</option>`,
        );
      }
    }

    if (customHint instanceof HTMLElement) {
      if (!inList && currentPreset && currentPreset !== 'native') {
        customHint.hidden = false;
        customHint.innerHTML = `Using a custom render size (${escapeHtml(this.manager.getResolutionDisplayLabel(currentPreset))}). <button type="button" class="msa-gfx__link" data-action="reset-resolution">Use recommended</button>`;
      } else {
        customHint.hidden = true;
        customHint.textContent = '';
      }
    }

    const particleSelect = root.querySelector('[data-input="particleSpawn"]');
    if (particleSelect instanceof HTMLSelectElement) {
      const currentTier = this.manager.getParticleSpawnUiTierId();
      particleSelect.innerHTML = this.manager.listParticleSpawnUiTierOptions()
        .map((row) => `<option value="${escapeHtml(row.id)}"${row.id === currentTier ? ' selected' : ''}>${escapeHtml(row.label)}</option>`)
        .join('');
    }

    const tokenDepth = root.querySelector('[data-input="tokenDepth"]');
    if (tokenDepth instanceof HTMLInputElement) {
      tokenDepth.checked = this.manager.getTokenDepthInteraction();
    }

    const vegetationHalfRes = root.querySelector('[data-input="vegetationHalfRes"]');
    if (vegetationHalfRes instanceof HTMLInputElement) {
      vegetationHalfRes.checked = this.manager.getVegetationHalfResEnabled();
    }
  }

  /** @private */
  _renderEffectGroups() {
    const host = this.container?.querySelector('[data-bind="effect-groups"]');
    if (!host) return;

    const groups = this.manager.listEffectsGroupedForUI();
    if (groups.length === 0) {
      host.innerHTML = '<p class="msa-gfx__empty">No effects registered for this scene yet.</p>';
      return;
    }

    host.innerHTML = groups.map((group) => {
      const expanded = this._expandedGroups.has(group.groupId);
      let active = 0;
      const rows = group.effects.map((entry) => {
        const avail = this.manager.getAvailability(entry.effectId);
        const enabled = this.manager.getEffectiveEnabled(entry.effectId);
        if (enabled) active++;
        const dotClass = !avail.available ? 'msa-gfx__dot--unavail' : (enabled ? 'msa-gfx__dot--on' : 'msa-gfx__dot--off');
        const title = !avail.available ? (avail.reason || 'Unavailable') : (enabled ? 'Active' : 'Disabled');
        const disabled = !avail.available ? ' disabled' : '';
        const checked = enabled ? ' checked' : '';
        return `
          <label class="msa-gfx__effect-row${!avail.available ? ' msa-gfx__effect-row--unavail' : ''}" title="${escapeHtml(title)}">
            <span class="msa-gfx__dot ${dotClass}" aria-hidden="true"></span>
            <input type="checkbox" class="msa-gfx__effect-check" data-input="effect-enabled" data-effect-id="${escapeHtml(entry.effectId)}"${checked}${disabled}>
            <span class="msa-gfx__effect-name">${escapeHtml(entry.displayName || entry.effectId)}</span>
          </label>`;
      }).join('');

      return `
        <div class="msa-gfx__group">
          <button type="button" class="msa-gfx__group-header" data-action="toggle-group" data-group-id="${escapeHtml(group.groupId)}">
            <span class="msa-gfx__chevron">${expanded ? '▼' : '▶'}</span>
            <span class="msa-gfx__group-label">${escapeHtml(group.groupLabel)}</span>
            <span class="msa-gfx__group-count">${active}/${group.effects.length} on</span>
          </button>
          <div class="msa-gfx__group-body"${expanded ? '' : ' hidden'}>${rows}</div>
        </div>`;
    }).join('');
  }

  /** @private */
  _updateEffectsCountTag() {
    const tag = this.container?.querySelector('[data-bind="effects-count"]');
    if (!tag) return;
    const all = this.manager.listEffectsForUI();
    let active = 0;
    for (const entry of all) {
      if (this.manager.getEffectiveEnabled(entry.effectId)) active++;
    }
    tag.textContent = `${active}/${all.length} on`;
  }

  refresh() {
    this._populatePerformanceControls();
    this._renderEffectGroups();
    this._syncAdvancedSection();
    this.refreshStatus();
  }

  refreshStatus() {
    this._updateEffectsCountTag();
  }

  show() {
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

  dispose() {
    if (this.container && this._boundStopHandlers) {
      try {
        const events = ['pointerdown', 'mousedown', 'click', 'dblclick', 'wheel'];
        for (const type of events) {
          this.container.removeEventListener(type, this._boundStopHandlers.stop);
        }
        this.container.removeEventListener('contextmenu', this._boundStopHandlers.stopAndPrevent);
      } catch (_) {}
    }

    try {
      this.container?.parentNode?.removeChild?.(this.container);
    } catch (_) {}

    this.container = null;
    this.visible = false;
  }
}
